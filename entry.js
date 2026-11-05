// dsh-session-deleter — Host half.
//
// dsh itself only knows how to ARCHIVE a session; the record on disk is kept
// forever. This half adds the missing half of the operation: it physically
// removes the session's record AND removes the session from every Host-side
// list, so the row disappears instead of lingering.
//
// The browser half cannot touch the filesystem, so the two halves talk through
// this entry's own settings namespace:
//
//   browser → host : write `pendingDeletes: ["<sessionId>#<nonce>"]`
//   host           : deletes the record, then ignores that token forever
//
// A token carries a nonce so the same session id can be deleted again later,
// and so a Host restart cannot replay a request that was already served.
//
// What "gone" takes. Three lists would otherwise keep the session visible, and
// each has its own release:
//
//   1. `session.list` — a live session (its Agent is still held) keeps
//      answering through `ctx.sessions`, even with its record deleted. The
//      store entries are detached, which emits `session/disposed`, which the
//      session controller turns into `api-session/removed` for every client.
//   2. `session.list` for a cold session — it is listed from the persistence
//      scan, so deleting the record is enough; the client is told explicitly
//      anyway, because a browser holding a stale list would keep showing the
//      row and then fail every message with ENOENT on the missing log.
//   3. the workspace registry's `sessionIds` — archiving deliberately keeps
//      that slot, so the row stays (marked "已归档") until the session is
//      detached from its Workspace.
//
// Windows notes (the reason this half is written the way it is):
//
//   * An open file cannot be unlinked on Windows. The session's write handle
//     is closed first, so the record is not busy when the delete runs; the
//     request also survives in a small on-disk queue and is retried until it
//     succeeds — at the latest on the next Host start.
//   * Paths are built with `path.join` / `path.basename`, never by splitting a
//     string on "/", because Windows separators are backslashes.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import z from "@deepseek-ai/schemastery";

/**
 * Whether the resolved schemastery can mark a Config field live-editable.
 *
 * `.volatile()` is what makes `dsh-settings` project a field into the settings
 * form, and it is the only channel a browser bundle can write through. It
 * exists from schemastery 3.18.4, which this package declares as a dependency.
 */
const LIVE_CAPABLE = typeof z.boolean().volatile === "function";

/** Mark one Config field live-editable, where the schema library allows it. */
function live(schema) {
  return LIVE_CAPABLE ? schema.volatile() : schema;
}

/** The well-known key cosmokit puts on a live config reference. */
const VOLATILE_REF = Symbol.for("cosmokit.volatile.write");

/** Whether a config value is a live reference rather than a plain snapshot. */
function isLive(value) {
  return typeof value === "object" && value !== null && VOLATILE_REF in value;
}

/**
 * Read one applied-config field.
 * @param config - The applied config, possibly undefined.
 * @param key - Field name.
 * @returns The current value, or undefined when the field is absent.
 */
function readField(config, key) {
  const value = config?.[key];
  return isLive(value) && typeof value.get === "function" ? value.get() : value;
}

/** The settings namespace this entry is mounted under. */
const NAMESPACE = "session-deleter";

/**
 * This entry's Host configuration schema.
 *
 * `pendingDeletes` is the command channel: the browser writes one token per
 * deletion request. `deleteSubagents` decides whether a deleted session takes
 * its subagent sessions with it.
 */
export const Config = z.object({
  pendingDeletes: live(z.array(z.string()).default([])),
  deleteSubagents: live(z.boolean().default(true)),
});

/** How many times one deletion is retried before it waits for the next start. */
const DELETE_ATTEMPTS = 5;

/** The pause between two attempts, in milliseconds. */
const DELETE_RETRY_MS = 400;

/**
 * The Host half.
 * @param ctx - Host plugin context.
 * @param config - The applied config; volatile fields arrive as live references.
 * @returns nothing.
 */
export async function apply(ctx, config) {
  const home = resolveHome(ctx);
  const sessionsRoot = join(home, "sessions");
  const projectionRoot = join(home, "storages", "session_projcache", "sessions");
  const queuePath = join(home, ".session-deleter-pending.json");

  /** Tokens already served; a token is never served twice. */
  const served = new Set();
  /** Tokens that could not be served yet (file busy, most likely). */
  let deferred = [];

  /**
   * The Host's own services this half needs. They are read through the dynamic
   * inject form, one per name, so a profile that mounts only some of them still
   * boots this plugin — and a missing name never silences the others.
   * @returns nothing.
   */
  const services = {
    workspaceRegistry: undefined,
    sessions: undefined,
    sessionPersistence: undefined,
    settings: undefined,
    agents: undefined,
  };
  for (const name of Object.keys(services)) {
    ctx.inject([name], (owner) => {
      services[name] = owner.get(name);
    });
  }

  /**
   * The Harness home directory.
   * @param context - Host plugin context.
   * @returns The absolute path of the Harness home.
   */
  function resolveHome(context) {
    try {
      const profile = context.profileContext;
      if (profile !== undefined && profile !== null && typeof profile.home === "string") return profile.home;
    } catch {
      /* the service is not reachable; fall back to the default location */
    }
    return join(homedir(), ".dsh");
  }

  /**
   * Every session record directory on disk.
   * @returns Absolute paths of `<home>/sessions/<workspace>/<session>` folders.
   */
  async function sessionDirectories() {
    const found = [];
    let workspaces = [];
    try {
      workspaces = await readdir(sessionsRoot, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      const workspaceDir = join(sessionsRoot, workspace.name);
      let sessions = [];
      try {
        sessions = await readdir(workspaceDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        found.push(join(workspaceDir, session.name));
      }
    }
    return found;
  }

  /**
   * Read one session's header record.
   * @param directory - A session record directory.
   * @returns The parsed header, or undefined when it cannot be read.
   */
  async function readHeader(directory) {
    const file = join(directory, "session.v4.jsonl.zstd");
    if (!existsSync(file)) return undefined;
    try {
      const raw = zstdDecompressSync(await readFile(file)).toString("utf8");
      const first = raw.split("\n", 1)[0];
      if (first === "") return undefined;
      const header = JSON.parse(first);
      return typeof header === "object" && header !== null ? header : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The session ids whose parent is the given session.
   * @param parentId - Parent session id.
   * @returns Ids of the direct subagent sessions.
   */
  async function childSessionIds(parentId) {
    const children = [];
    for (const directory of await sessionDirectories()) {
      const header = await readHeader(directory);
      if (header === undefined) continue;
      if (header.parentSession === parentId) children.push(header.id ?? basename(directory));
    }
    return children.filter((id) => typeof id === "string");
  }

  /**
   * Whether an error means "the file is in use", which is a Windows-only
   * condition for an unlink and is worth retrying rather than failing.
   * @param error - The thrown error.
   * @returns Whether the error is a busy-file error.
   */
  function isBusy(error) {
    const code = error !== null && typeof error === "object" ? error.code : undefined;
    return code === "EBUSY" || code === "EPERM" || code === "EACCES";
  }

  /**
   * Remove one path, retrying while the system reports the file as in use.
   * @param path - The path to remove.
   * @returns nothing.
   * @throws The last error when every attempt failed.
   */
  async function removeWithRetry(path) {
    let last;
    for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt++) {
      try {
        await rm(path, { recursive: true, force: true });
        return;
      } catch (error) {
        last = error;
        if (!isBusy(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, DELETE_RETRY_MS));
      }
    }
    throw last;
  }

  /**
   * Close this session's write handle and drop its unmaterialized entry.
   *
   * The persistence tracker holds every open handle; a live write handle keeps
   * the log file open, which on Windows makes the record impossible to unlink.
   * Closing it also stops the backend from routing further events into a log
   * this plugin is about to delete.
   * @param sessionId - The session whose handles are released.
   * @returns nothing.
   */
  async function closeHandles(sessionId) {
    const tracker = services.sessionPersistence?.tracker;
    if (tracker === undefined || tracker === null) return;
    try {
      const open = tracker.openHandles;
      if (open !== undefined && typeof open[Symbol.iterator] === "function") {
        for (const handle of [...open]) {
          if (handle === undefined || handle === null || handle.id !== sessionId) continue;
          try {
            await handle.close();
          } catch (error) {
            ctx.logger?.warn?.(`session-deleter: could not close the handle for ${sessionId}`, error);
          }
        }
      }
      // A session this process created but never wrote must not survive as a
      // pending entry once its record is gone.
      tracker.pending?.delete?.(sessionId);
    } catch (error) {
      ctx.logger?.warn?.(`session-deleter: could not release handles for ${sessionId}`, error);
    }
  }

  /**
   * Archive one session on the Host.
   *
   * Archiving is what the Host offers instead of deleting: it stops the
   * session's running work and makes the archive gate refuse further model
   * steps. The row stays visible (marked "已归档") — that is why this half also
   * detaches the session afterwards.
   * @param sessionId - The session to archive.
   * @returns nothing.
   */
  async function archiveOnHost(sessionId) {
    const registry = services.workspaceRegistry;
    if (registry === undefined || registry === null) return;
    try {
      await registry.archiveSession(sessionId, { stopActivity: true });
    } catch (error) {
      ctx.logger?.warn?.(`session-deleter: could not archive ${sessionId}`, error);
    }
  }

  /**
   * Stop a live agent the way the Host's own teardown does.
   *
   * Detaching the store entries only unlists the session; the agent's loop
   * would keep running (and keep spending tokens) until the app closes. The
   * driver's own teardown cancels the loop, waits for it to go idle, and
   * disposes its scope — those three calls are the same ones the agent
   * factory's disposal runs.
   * @param sessionId - The session whose agent should stop.
   * @returns nothing.
   */
  async function stopAgent(sessionId) {
    try {
      const agent = services.agents?.get?.(sessionId);
      if (agent === undefined || agent === null) return;
      try {
        agent.cancel?.({ kind: "disposed" });
      } catch (error) {
        ctx.logger?.warn?.(`session-deleter: could not cancel the agent for ${sessionId}`, error);
      }
      try {
        await agent.whenIdle?.();
      } catch (error) {
        ctx.logger?.warn?.(`session-deleter: the agent for ${sessionId} did not go idle`, error);
      }
      try {
        await agent.scope?.dispose?.();
      } catch (error) {
        ctx.logger?.warn?.(`session-deleter: could not dispose the agent scope for ${sessionId}`, error);
      }
    } catch (error) {
      ctx.logger?.warn?.(`session-deleter: could not stop the agent for ${sessionId}`, error);
    }
  }

  /**
   * Remove one session from the Host's live stores.
   *
   * A live session keeps answering `session.list` from memory even with its
   * record deleted, which is exactly the state that later fails a message with
   * ENOENT on the missing log. Detaching the store entries emits
   * `session/disposed` / `agent/disposed`, and the session controller forwards
   * that to every client as `api-session/removed`, so the row disappears.
   * @param sessionId - The session to drop.
   * @returns Whether the session was live and has been dropped.
   */
  function dropLive(sessionId) {
    let dropped = false;
    try {
      const sessions = services.sessions;
      const entry = sessions?.store?.get?.(sessionId);
      if (entry !== undefined && entry !== null) {
        if (typeof entry.detach === "function") entry.detach();
        else if (typeof sessions.detachEntered === "function") sessions.detachEntered(entry);
        dropped = true;
      }
    } catch (error) {
      ctx.logger?.warn?.(`session-deleter: could not drop the live session ${sessionId}`, error);
    }
    try {
      const agents = services.agents;
      const entry = agents?.store?.get?.(sessionId);
      if (entry !== undefined && entry !== null && typeof agents.detachEntered === "function") {
        agents.detachEntered(entry);
        dropped = true;
      }
    } catch (error) {
      ctx.logger?.warn?.(`session-deleter: could not drop the live agent ${sessionId}`, error);
    }
    return dropped;
  }

  /**
   * Tell every client the session is gone.
   *
   * A cold session's deletion is invisible to a browser holding a stale list;
   * the row would stay until some other change forced a re-list, and a message
   * to it would fail on the missing log. The same event the Host itself emits
   * when a session is disposed is what clients listen to for removal.
   * @param sessionId - The removed session id.
   * @returns nothing.
   */
  function notifyRemoved(sessionId) {
    try {
      ctx.emit("api-session/removed", sessionId);
    } catch (error) {
      ctx.logger?.warn?.(`session-deleter: could not notify clients about ${sessionId}`, error);
    }
  }

  /**
   * Remove one session from its Workspace's accounting.
   *
   * Archiving keeps the `sessionIds` slot on purpose (so unarchiving restores
   * the position). A deleted session has nothing to restore, so the slot is
   * dropped and the row cannot come back through the workspace tree.
   * @param sessionId - The session to detach.
   * @returns nothing.
   */
  async function detachFromWorkspace(sessionId) {
    const registry = services.workspaceRegistry;
    if (registry === undefined || registry === null) return;
    try {
      if (typeof registry.detachSession === "function") await registry.detachSession(sessionId);
    } catch (error) {
      ctx.logger?.warn?.(`session-deleter: could not detach ${sessionId} from its workspace`, error);
    }
  }

  /**
   * Leave the registry-global archive set.
   *
   * The session is gone, so the archived slot it occupies would only be dead
   * weight — and a filter that lists archived sessions would keep naming an id
   * no surface can show.
   * @param sessionId - The session to unarchive.
   * @returns nothing.
   */
  async function unarchiveOnHost(sessionId) {
    const registry = services.workspaceRegistry;
    if (registry === undefined || registry === null) return;
    try {
      await registry.unarchiveSession(sessionId);
    } catch (error) {
      ctx.logger?.warn?.(`session-deleter: could not unarchive ${sessionId}`, error);
    }
  }

  /**
   * Remove one session's projection cache (title, usage and list metadata).
   * @param sessionId - The session whose projection cache is removed.
   * @returns nothing.
   */
  async function removeProjection(sessionId) {
    const projection = join(projectionRoot, `${sessionId}.json`);
    if (!existsSync(projection)) return;
    await removeWithRetry(projection);
  }

  /**
   * Remove one session's record and every Host-side trace of it.
   * @param sessionId - The session to remove.
   * @returns The ids actually removed.
   */
  async function purge(sessionId) {
    const removed = [];

    // 1. Stop the running work and refuse further model steps.
    await archiveOnHost(sessionId);
    await stopAgent(sessionId);

    // 2. Release the write handle, so the record is not busy on Windows.
    await closeHandles(sessionId);

    // 3. Remove the record from disk.
    for (const directory of await sessionDirectories()) {
      if (basename(directory) !== sessionId) continue;
      await removeWithRetry(directory);
      removed.push(sessionId);
    }
    await removeProjection(sessionId);

    // 4. Take the session out of every Host-side list, and out of its
    //    Workspace's accounting, so no surface can bring the row back.
    const wasLive = dropLive(sessionId);
    if (!wasLive) notifyRemoved(sessionId);
    await detachFromWorkspace(sessionId);
    await unarchiveOnHost(sessionId);

    // 5. A still-live session rewrites its projection cache while it is being
    //    torn down, so the cache is swept again after the live entries are
    //    gone — otherwise one stale JSON keeps a nameable trace of a session
    //    nothing else can open.
    await removeProjection(sessionId);

    // 6. Subagent sessions go with their parent.
    if (readField(config, "deleteSubagents") !== false) {
      for (const child of await childSessionIds(sessionId)) {
        if (child === sessionId) continue;
        removed.push(...(await purge(child)));
      }
    }
    return removed;
  }

  /**
   * Persist the requests that could not be served yet.
   * @param tokens - The token strings still waiting.
   * @returns nothing.
   */
  async function persistDeferred(tokens) {
    try {
      await mkdir(dirname(queuePath), { recursive: true });
      await writeFile(queuePath, JSON.stringify({ tokens }), "utf8");
    } catch (error) {
      ctx.logger?.warn?.("session-deleter: could not persist the pending queue", error);
    }
  }

  /**
   * Read the persisted queue written by an earlier run.
   * @returns The token strings left over from an earlier run.
   */
  async function readDeferred() {
    try {
      const raw = JSON.parse(await readFile(queuePath, "utf8"));
      const tokens = raw !== null && typeof raw === "object" && Array.isArray(raw.tokens) ? raw.tokens : [];
      return tokens.filter((token) => typeof token === "string");
    } catch {
      return [];
    }
  }

  /**
   * Drop the tokens that were served from the settings document.
   *
   * The browser writes the command into the profile's settings layer, so
   * without this the document would keep one entry per deletion forever, and a
   * Host restart would serve every historical request again.
   * @param queue - The queue as the Host last read it.
   * @returns nothing.
   */
  async function clearServedTokens(queue) {
    const settings = services.settings;
    if (settings === undefined || settings === null) return;
    const remaining = Array.isArray(queue) ? queue.filter((token) => !served.has(token)) : [];
    if (remaining.length === (Array.isArray(queue) ? queue.length : 0)) return;
    try {
      // The Host-side describe() answers with the descriptor array; the Remote
      // face wraps the same list as `{ namespaces }`.
      const view = await settings.describe();
      const rows = Array.isArray(view) ? view : Array.isArray(view?.namespaces) ? view.namespaces : [];
      const row = rows.find((candidate) => candidate?.ns === NAMESPACE);
      if (row === undefined) return;
      await settings.mutate(NAMESPACE, [{ op: "set", path: ["pendingDeletes"], value: remaining }], row.revision);
    } catch (error) {
      ctx.logger?.warn?.("session-deleter: could not clear the served requests", error);
    }
  }

  /**
   * Remove the sessions the Host still holds whose record is already gone.
   *
   * This is the self-heal for a delete that happened while the Host was
   * running, or under an earlier release of this plugin: the file is gone, the
   * live session is not, so the sidebar keeps listing a session that cannot be
   * opened. A session the persistence layer still knows about (on disk, or
   * created but not yet materialized) is left alone; only a session that is in
   * neither place is an orphan.
   * @returns nothing.
   */
  async function healOrphans() {
    const live = services.sessions;
    const persistence = services.sessionPersistence;
    if (live === undefined || live === null || typeof live.list !== "function") return;
    let known = new Set();
    if (persistence !== undefined && persistence !== null && typeof persistence.list === "function") {
      try {
        for (const snapshot of await persistence.list()) {
          if (snapshot !== undefined && snapshot !== null && snapshot.header !== undefined) known.add(snapshot.header.id);
        }
      } catch (error) {
        ctx.logger?.warn?.("session-deleter: could not read the persistence listing", error);
        return;
      }
    }
    const onDisk = new Set((await sessionDirectories()).map((directory) => basename(directory)));
    for (const session of live.list()) {
      const id = session?.id;
      if (typeof id !== "string" || id === "") continue;
      if (known.has(id) || onDisk.has(id)) continue;
      // Same release path as a deletion, minus the file work: the record is
      // already gone.
      await archiveOnHost(id);
      await stopAgent(id);
      await closeHandles(id);
      const wasLive = dropLive(id);
      if (!wasLive) notifyRemoved(id);
      await detachFromWorkspace(id);
      await unarchiveOnHost(id);
      ctx.logger?.warn?.(`session-deleter: removed ${id}, whose record was gone while the Host still held it`);
    }
  }

  /**
   * Serve every pending request that has not been served yet.
   * @returns nothing.
   */
  async function process() {
    const queue = readField(config, "pendingDeletes");
    const fromBrowser = Array.isArray(queue) ? queue : [];
    // Whatever an earlier run could not serve is retried first: nothing holds
    // those files any more by the time this Host starts.
    const pending = [...deferred, ...fromBrowser];
    deferred = [];

    for (const token of pending) {
      if (typeof token !== "string" || served.has(token)) continue;
      const sessionId = token.split("#")[0];
      if (sessionId === "") {
        served.add(token);
        continue;
      }
      try {
        const removed = await purge(sessionId);
        served.add(token);
        ctx.logger?.info?.(
          `session-deleter: removed ${removed.length} record(s) for ${sessionId}` +
            (removed.length === 0 ? " (nothing left on disk)" : ""),
        );
      } catch (error) {
        if (isBusy(error)) {
          // The record is still open somewhere. Keep the request and try again
          // later; on Windows this is the normal path for a live session.
          deferred.push(token);
          ctx.logger?.warn?.(`session-deleter: ${sessionId} is in use; will retry`, error);
        } else {
          served.add(token);
          ctx.logger?.error?.(`session-deleter: failed to remove ${sessionId}`, error);
        }
      }
    }

    if (deferred.length > 0) await persistDeferred(deferred);
    else if (existsSync(queuePath)) await rm(queuePath, { force: true });
    await clearServedTokens(fromBrowser);
  }

  // The loader commits a volatile edit into the same live reference and emits
  // this event, so the common path is immediate. The interval is the fallback
  // for a write that landed before this fiber started listening.
  ctx.on("loader/volatile-update", () => {
    void process();
  });
  // A plain Node timer, not `ctx.setInterval`: the timer service would have to be
  // declared as an injected dependency, and this half must not be able to keep a
  // profile from booting.
  const timer = setInterval(() => {
    void process();
  }, 700);
  timer.unref?.();
  ctx.effect(() => () => {
    clearInterval(timer);
  });

  deferred = await readDeferred();
  await process();
  await healOrphans();
}
