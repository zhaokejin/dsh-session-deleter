// dsh-session-deleter — browser half.
//
// One card on 设置 → 插件 → 插件配置, named 「会话彻底删除」. It lists every
// session the Host knows about and, on a click, asks the Host half to remove
// that session's record from disk. dsh itself only archives; this is the
// physical delete.
//
// The browser cannot touch the filesystem and has no generated Remote
// namespace of its own, so the request travels through this entry's own
// settings namespace: the browser writes one token into `pendingDeletes`, and
// the Host half serves it and deletes the record.

window.__ModuleLoader__.load({
  id: "dsh-session-deleter",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = null;
    try {
      React = require("react");
    } catch (error) {
      React = null;
    }
    if (React === null || typeof React.createElement !== "function") return module.exports;
    var h = React.createElement;
    // The shared client primitives: the menu item, the tooltip and the trash icon
    // are the same components the shipped session menu uses.
    var primitives = null;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      primitives = null;
    }

    /** Settings namespace the Host half registers; also this card's slot key. */
    var NAMESPACE = "session-deleter";
    /** The Plugins settings page dispatches cards by slot name. */
    var SLOT = "plugins.item";
    /** Client dictionary namespace this card's tab label is read from. */
    var LOCALE_NAMESPACE = "sessionDeleter";

    var DICTIONARY_ZH = {
      title: "会话彻底删除",
      summary: "从磁盘物理删除会话记录",
      intro: "dsh 自带只能「归档」会话，记录会一直留在磁盘上。这里可以真正删掉。",
      empty: "没有会话",
      loading: "读取会话列表…",
      column: "会话",
      updated: "更新时间",
      size: "大小",
      action: "删除",
      deleting: "删除中…",
      deleted: "已删除，已刷新列表",
      failed: "删除失败",
      child: "子智能体",
      running: "运行中",
      current: "当前",
      confirm: "彻底删除这个会话？\n\n会话记录会从磁盘上永久移除，无法恢复。它的子智能体会一起删除。",
      purgeArchived: "清空已归档",
      purgeConfirm: "把所有已归档会话从磁盘上删掉？",
      blocked: "本部署不接受设置写入，删除通道不可用。",
      deleteCurrent: "彻底删除当前会话",
      confirmNamed: "彻底删除「{name}」？\n\n会话记录会从磁盘上永久移除，无法恢复。它的子智能体会一起删除。",
      menuDelete: "彻底删除（不可恢复）",
      deleted: "已删除",
      configTitle: "配置",
      optConfirm: "删除前询问确认（显示会话名）",
      optSubagents: "删除父会话时一并删除子智能体",
      optRowButton: "侧栏行显示删除按钮",
      optHeaderButton: "标题栏显示删除按钮",
      optAttempts: "文件占用重试次数",
      optSaved: "配置已保存",
    };

    var DICTIONARY_EN = {
      title: "Delete sessions",
      summary: "Remove session records from disk",
      intro: "dsh can only archive a session; the record stays on disk forever. This removes it.",
      empty: "No sessions",
      loading: "Reading the session list…",
      column: "Session",
      updated: "Updated",
      size: "Size",
      action: "Delete",
      deleting: "Deleting…",
      deleted: "Deleted; the list is refreshed",
      failed: "Deletion failed",
      child: "subagent",
      running: "running",
      current: "current",
      confirm: "Delete this session for good?\n\nIts record is removed from disk and cannot be restored. Its subagent sessions go with it.",
      purgeArchived: "Purge archived",
      purgeConfirm: "Delete every archived session from disk?",
      blocked: "This deployment does not accept settings writes, so the delete channel is unavailable.",
      deleteCurrent: "Delete this session for good",
      confirmNamed: "Delete “{name}” for good?\n\nIts record is removed from disk and cannot be restored. Its subagent sessions go with it.",
      menuDelete: "Delete for good (permanent)",
      deleted: "Deleted",
      configTitle: "Options",
      optConfirm: "Ask before deleting (shows the session name)",
      optSubagents: "Delete subagent sessions together with the parent",
      optRowButton: "Show the delete button on sidebar rows",
      optHeaderButton: "Show the delete button in the session header",
      optAttempts: "Busy-file retry count",
      optSaved: "Options saved",
    };

    /**
     * Read one awaited service from the injected owner context.
     * @param owner - The context passed to the inject callback.
     * @param name - Service name.
     * @returns The service, or undefined.
     */
    function serviceAt(owner, name) {
      try {
        if (owner !== null && owner !== undefined && typeof owner.get === "function") {
          var value = owner.get(name);
          if (value !== undefined && value !== null) return value;
        }
      } catch (error) {
        /* fall through to the property read */
      }
      return owner === null || owner === undefined ? undefined : owner[name];
    }

    /**
     * The title of one session row, whatever shape the Host sent it in.
     * @param item - A session list row.
     * @returns A display title, or undefined.
     */
    function titleOf(item) {
      if (item === undefined || item === null) return undefined;
      var values = item.projections === undefined || item.projections === null ? undefined : item.projections.values;
      if (values !== undefined && values !== null) {
        var title = values.title;
        if (typeof title === "string" && title !== "") return title;
        if (title !== undefined && title !== null && typeof title.value === "string" && title.value !== "") return title.value;
      }
      if (typeof item.displayTitle === "string" && item.displayTitle !== "") return item.displayTitle;
      if (typeof item.title === "string" && item.title !== "") return item.title;
      return undefined;
    }

    /**
     * A short, readable timestamp.
     * @param value - Milliseconds since the epoch.
     * @returns A localized-ish string, or an empty string.
     */
    function timeOf(value) {
      if (typeof value !== "number" || !isFinite(value)) return "";
      try {
        return new Date(value).toLocaleString();
      } catch (error) {
        return "";
      }
    }


    /**
     * Ask the Host to delete one session.
     * @param remote - The Remote service.
     * @param sessionId - The session to remove.
     * @param t - The locale reader.
     * @returns A promise resolving when the request was accepted.
     */
    function requestDelete(settings, sessionId, t, workspace) {
      if (settings === undefined || settings === null || typeof settings.mutate !== "function") {
        return Promise.reject(new Error(t("blocked")));
      }
      var token = sessionId + "#" + Date.now();
      // Archive FIRST, through the Host's own API: archiving stops the running
      // work, hides the session from every grouping surface, and makes the
      // Host's archive gate refuse further model steps. Without it the Host
      // keeps the session live, the sidebar still lists it, and sending a
      // message would reopen the log this plugin is about to delete.
      var archived =
        workspace !== undefined && workspace !== null && typeof workspace.archiveSession === "function"
          ? Promise.resolve(workspace.archiveSession({ sessionId: sessionId, stopActivity: true })).catch(function () {
              // An unknown session is already gone; the delete still proceeds.
              return undefined;
            })
          : Promise.resolve(undefined);
      return archived
        .then(function () {
          return settings.describe();
        })
        .then(function (result) {
          // A Remote answer is `{ ok, value }`; the namespaces live in the value.
          var view = result !== null && result !== undefined && result.ok === true ? result.value : undefined;
          var namespaces = view !== null && view !== undefined && Array.isArray(view.namespaces) ? view.namespaces : [];
          var row = namespaces.find(function (candidate) {
            return candidate !== null && candidate !== undefined && candidate.ns === NAMESPACE;
          });
          if (row === undefined) throw new Error(t("blocked"));
          return settings.mutate(NAMESPACE, [{ op: "set", path: ["pendingDeletes"], value: [token] }], row.revision);
        })
        .then(function (answer) {
          if (answer !== null && answer !== undefined && answer.ok === false) {
            var reason = answer.error === undefined || answer.error === null ? "" : String(answer.error.message ?? answer.error);
            throw new Error(reason === "" ? t("failed") : reason);
          }
          return token;
        });
    }



    /**
     * Read this plugin's applied config from the settings document.
     * @param settings - The settings namespace service (remote in browsers).
     * @returns A promise of `{ value, revision }`, or null when unreadable.
     */
    function readConfig(settings) {
      if (settings === undefined || settings === null || typeof settings.describe !== "function") return Promise.resolve(null);
      return Promise.resolve(settings.describe())
        .then(function (result) {
          var view = result !== null && result !== undefined && result.ok === true ? result.value : undefined;
          var namespaces = view !== null && view !== undefined && Array.isArray(view.namespaces) ? view.namespaces : [];
          var row = namespaces.find(function (candidate) {
            return candidate !== null && candidate !== undefined && candidate.ns === NAMESPACE;
          });
          if (row === undefined) return null;
          return { value: row.value !== null && typeof row.value === "object" ? row.value : {}, revision: row.revision };
        })
        .catch(function () {
          return null;
        });
    }

    /**
     * Write one config field back through the settings document.
     * @param settings - The settings namespace service.
     * @param key - The Config field name.
     * @param value - The new value.
     * @param t - The locale reader.
     * @returns A promise resolving when the write was accepted.
     */
    function writeConfig(settings, key, value, t) {
      if (settings === undefined || settings === null || typeof settings.mutate !== "function") {
        return Promise.reject(new Error(t("blocked")));
      }
      return readConfig(settings)
        .then(function (row) {
          if (row === null) throw new Error(t("blocked"));
          return settings.mutate(NAMESPACE, [{ op: "set", path: [key], value: value }], row.revision);
        })
        .then(function (answer) {
          if (answer !== null && answer !== undefined && answer.ok === false) {
            var reason = answer.error === undefined || answer.error === null ? "" : String(answer.error.message ?? answer.error);
            throw new Error(reason === "" ? t("failed") : reason);
          }
          return undefined;
        });
    }

    /**
     * Whether one deletion may proceed right now: honours `confirmBeforeDelete`.
     * @param settings - The settings namespace service.
     * @param message - The confirmation text, shown only when the option is on.
     * @returns A promise of true when the deletion may go ahead.
     */
    function confirmAllowed(settings, message) {
      return readConfig(settings).then(function (row) {
        var need = row === null || row.value === undefined ? true : row.value.confirmBeforeDelete !== false;
        if (!need) return true;
        if (typeof window !== "undefined" && typeof window.confirm === "function") return window.confirm(message) === true;
        return true;
      });
    }

    /**
     * Delete one session and refresh the page.
     * @param runtime - React.
     * @param settings - The settings namespace service.
     * @param sessionId - The session to remove.
     * @param t - The locale reader.
     * @returns nothing.
     */
    function deleteAndReload(runtime, settings, sessionId, t, workspace) {
      // `Promise.resolve().then(…)`: a synchronous throw inside the request
      // must reach the same `catch`, never escape the click handler.
      Promise.resolve()
        .then(function () {
          return confirmAllowed(settings, t("confirm"));
        })
        .then(function (ok) {
          if (ok !== true) return undefined;
          return requestDelete(settings, sessionId, t, workspace).then(function () {
            setTimeout(function () {
              if (typeof location !== "undefined") location.reload();
            }, 1200);
          });
        })
        .catch(function (error) {
          console.warn("session-deleter: delete failed", error);
        });
      return true;
    }

    /**
     * Render one element only while a boolean config option is not false.
     * The read is async, so the element shows by default and disappears once
     * the settings document says otherwise.
     * @param props - Slot props plus `flag` and `build`.
     * @returns The built element, or null.
     */
    function ConfigGate(props) {
      var runtime = props.runtime;
      var settings = props.settings;
      var flag = props.flag;
      var build = props.build;
      var [allowed, setAllowed] = runtime.useState(true);
      runtime.useEffect(
        function () {
          var alive = true;
          readConfig(settings).then(function (row) {
            if (!alive) return;
            setAllowed(row === null || row.value === undefined ? true : row.value[flag] !== false);
          });
          return function () {
            alive = false;
          };
        },
        [settings, flag],
      );
      if (allowed === false) return null;
      return build();
    }

    /**
     * The ⋯ menu entry: "彻底删除".
     * @param props - Slot props: runtime, settings, locale and the session id.
     * @returns The menu item element.
     */
    function DeleteSessionMenuItem(props) {
      var runtime = props.runtime;
      var settings = props.settings;
      var t = props.t;
      var sessionId = props.sessionId;
      if (typeof sessionId !== "string" || sessionId === "") return null;
      var MenuItemButton = primitives === null ? null : primitives.MenuItemButton;
      var IconTrash = primitives === null ? null : primitives.IconTrashOutlineRegular;
      if (MenuItemButton === null) {
        return h(
          "button",
          {
            type: "button",
            style: { color: "rgb(239 68 68)", font: "inherit", background: "none", border: "none", cursor: "pointer" },
            onClick: function () {
              deleteAndReload(runtime, settings, sessionId, t, props.workspace);
            },
          },
          t("menuDelete"),
        );
      }
      return h(MenuItemButton, {
        icon: IconTrash === null ? undefined : h(IconTrash, { size: 14 }),
        onSelect: function () {
          deleteAndReload(runtime, settings, sessionId, t, props.workspace);
        },
        children: t("menuDelete"),
      });
    }

    /**
     * The hover button on a session row: a trash icon next to the archive icon.
     * @param props - Slot props: runtime, settings, locale and the session id.
     * @returns The button element.
     */
    function DeleteSessionRowButton(props) {
      return h(ConfigGate, {
        runtime: props.runtime,
        settings: props.settings,
        flag: "showRowButton",
        build: function () {
          return h(RowDeleteButton, props);
        },
      });
    }

    /**
     * The hover button body on a session row: a trash icon next to the archive icon.
     * @param props - Slot props: runtime, settings, locale and the session id.
     * @returns The button element.
     */
    function RowDeleteButton(props) {
      var runtime = props.runtime;
      var settings = props.settings;
      var t = props.t;
      var sessionId = props.sessionId;
      if (typeof sessionId !== "string" || sessionId === "") return null;
      var Tooltip = primitives === null ? null : primitives.Tooltip;
      var IconTrash = primitives === null ? null : primitives.IconTrashOutlineRegular;
      var button = h(
        "button",
        {
          type: "button",
          "aria-label": t("deleteCurrent"),
          title: t("deleteCurrent"),
          onClick: function (event) {
            if (event !== undefined && event !== null && typeof event.stopPropagation === "function") event.stopPropagation();
            deleteAndReload(runtime, settings, sessionId, t, props.workspace);
          },
          style: {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "22px",
            height: "22px",
            border: "none",
            background: "transparent",
            color: "rgb(239 68 68)",
            borderRadius: "6px",
            cursor: "pointer",
            opacity: 0.7,
          },
        },
        IconTrash === null ? "🗑" : h(IconTrash, { size: 14 }),
      );
      if (Tooltip === null) return button;
      return h(Tooltip, { label: t("deleteCurrent"), side: "bottom", align: "end", delayMs: 500, portal: true }, button);
    }

    /**
     * The header button: delete the session that is open right now.
     * @param props - Slot props: runtime, settings, locale and the scope props.
     * @returns The button element.
     */
    function DeleteCurrentButton(props) {
      return h(ConfigGate, {
        runtime: props.runtime,
        settings: props.settings,
        flag: "showHeaderButton",
        build: function () {
          return h(CurrentDeleteButton, props);
        },
      });
    }

    /**
     * The header button body: delete the session that is open right now.
     * @param props - Slot props: runtime, settings, locale and the scope props.
     * @returns The button element.
     */
    function CurrentDeleteButton(props) {
      var runtime = props.runtime;
      var settings = props.settings;
      var workspace = props.workspace;
      var t = props.t;
      var sessionId = props.sessionId;
      var [busy, setBusy] = runtime.useState(false);
      if (typeof sessionId !== "string" || sessionId === "") return null;
      var onClick = function () {
        if (busy) return;
        setBusy(true);
        Promise.resolve()
          .then(function () {
            return confirmAllowed(settings, t("confirm"));
          })
          .then(function (ok) {
            if (ok !== true) {
              setBusy(false);
              return undefined;
            }
            return requestDelete(settings, sessionId, t, workspace).then(function () {
              setTimeout(function () {
                if (typeof location !== "undefined") location.reload();
              }, 1200);
            });
          })
          .catch(function (error) {
            setBusy(false);
            console.warn("session-deleter: header delete failed", error);
          });
      };
      return h(
        "button",
        {
          type: "button",
          title: t("deleteCurrent"),
          "aria-label": t("deleteCurrent"),
          disabled: busy,
          onClick: onClick,
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            border: "0.5px solid rgba(0,0,0,0.15)",
            background: "transparent",
            color: "inherit",
            borderRadius: "6px",
            padding: "2px 8px",
            fontSize: "12px",
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.5 : 0.75,
          },
        },
        busy ? t("deleting") : "🗑 " + t("action"),
      );
    }

    /**
     * The card body.
     * @param props - Slot props: runtime, remote and the session service.
     * @returns The card element.
     */
    function DeleterCard(props) {
      var runtime = props.runtime;
      var settings = props.settings;
      var sessionRemote = props.sessionRemote;
      var workspace = props.workspace;
      var t = props.t;
      var [rows, setRows] = runtime.useState(null);
      var [busy, setBusy] = runtime.useState(null);
      var [note, setNote] = runtime.useState(null);
      var [failed, setFailed] = runtime.useState(null);
      var [cfg, setCfg] = runtime.useState(null);

      /**
       * Read the session list from the Host.
       * @returns The rows, or an empty array.
       */
      var load = runtime.useCallback(
        function (attempt) {
          if (sessionRemote === undefined || sessionRemote === null || typeof sessionRemote.list !== "function") {
            setRows([]);
            return Promise.resolve([]);
          }
          return Promise.resolve()
            .then(function () {
              return sessionRemote.list({});
            })
            .then(function (result) {
              if (result !== null && result !== undefined && result.ok === true && result.value !== undefined) {
                return Array.isArray(result.value.items) ? result.value.items : [];
              }
              throw new Error("the session list was refused");
            })
            .then(function (items) {
              setRows(items);
              return items;
            })
            .catch(function (error) {
              // A listing can fail transiently while another delete is moving
              // the records around. Wiping the rows would look exactly like
              // "nothing happened", so the rows already on screen are kept and
              // the read is retried once before reporting anything.
              if ((attempt || 0) < 2) {
                return new Promise(function (resolve) {
                  setTimeout(resolve, 900);
                }).then(function () {
                  return load((attempt || 0) + 1);
                });
              }
              setFailed(t("failed") + ": " + String(error instanceof Error ? error.message : error));
              return [];
            });
        },
        [sessionRemote, t],
      );

      runtime.useEffect(function () {
        void load(0);
      }, [load]);

      /**
       * Read this plugin's own config for the options section.
       * @returns nothing.
       */
      var loadCfg = runtime.useCallback(
        function () {
          return readConfig(settings).then(function (row) {
            setCfg(row === null || row.value === undefined || row.value === null ? {} : row.value);
          });
        },
        [settings],
      );
      runtime.useEffect(function () {
        void loadCfg();
      }, [loadCfg]);

      /**
       * Write one option back and refresh the section.
       * @param key - The Config field name.
       * @param value - The new value.
       * @returns nothing.
       */
      var setOpt = runtime.useCallback(
        function (key, value) {
          var next = {};
          next[key] = value;
          setCfg(Object.assign({}, cfg, next));
          writeConfig(settings, key, value, t)
            .then(function () {
              setNote(t("optSaved"));
              void loadCfg();
            })
            .catch(function (error) {
              setFailed(t("failed") + ": " + String(error instanceof Error ? error.message : error));
              void loadCfg();
            });
        },
        [cfg, settings, t, loadCfg],
      );

      /**
       * Ask the Host to delete one session, then refresh the page.
       * @param sessionId - The session to remove.
       * @returns nothing.
       */
      var remove = runtime.useCallback(
        function (sessionId, name) {
          if (busy !== null) return;
          var message = typeof name === "string" && name !== "" ? t("confirmNamed").replace("{name}", name) : t("confirm");
          setBusy(sessionId);
          setNote(null);
          setFailed(null);
          // `Promise.resolve().then(…)`: a synchronous throw inside the request
          // must reach the same `catch`, or the button stays busy for good.
          Promise.resolve()
            .then(function () {
              return confirmAllowed(settings, message);
            })
            .then(function (ok) {
              if (ok !== true) {
                setBusy(null);
                return undefined;
              }
              return requestDelete(settings, sessionId, t, workspace);
            })
            .then(function (token) {
              if (token === undefined) return;
              setNote(t("deleted"));
              // The Host removes the record asynchronously; re-read the list
              // after it has had a moment, so the row disappears in place and
              // the button never depends on a page reload to recover.
              setTimeout(function () {
                setBusy(null);
                void load(0);
              }, 1200);
            })
            .catch(function (error) {
              setFailed(t("failed") + ": " + String(error instanceof Error ? error.message : error));
              setBusy(null);
            });
        },
        [busy, settings, workspace, t, load],
      );

      if (rows === null) {
        return h("div", { style: { padding: "8px 0", opacity: 0.6 } }, t("loading"));
      }

      var sorted = rows.slice().sort(function (left, right) {
        return (typeof right.updatedAt === "number" ? right.updatedAt : 0) - (typeof left.updatedAt === "number" ? left.updatedAt : 0);
      });

      // The options section: every field of the Host Config that is meant for
      // humans, edited in place through the settings document.
      var OPTION_DEFAULTS = {
        confirmBeforeDelete: true,
        deleteSubagents: true,
        showRowButton: true,
        showHeaderButton: true,
        deleteAttempts: 5,
      };
      var options = cfg === null ? null : Object.assign({}, OPTION_DEFAULTS, cfg);
      var checkbox = function (key, label) {
        return h(
          "label",
          { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer" } },
          h("input", {
            type: "checkbox",
            checked: options[key] !== false,
            onChange: function (event) {
              setOpt(key, event.target.checked);
            },
          }),
          label,
        );
      };
      var cfgSection =
        options === null
          ? null
          : h(
              "div",
              {
                style: {
                  border: "0.5px solid rgba(0,0,0,0.12)",
                  borderRadius: "8px",
                  padding: "8px 10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                },
              },
              h("div", { style: { fontSize: "12px", opacity: 0.7, fontWeight: 600 } }, t("configTitle")),
              h(
                "div",
                { style: { display: "flex", flexWrap: "wrap", gap: "6px 18px" } },
                checkbox("confirmBeforeDelete", t("optConfirm")),
                checkbox("deleteSubagents", t("optSubagents")),
                checkbox("showRowButton", t("optRowButton")),
                checkbox("showHeaderButton", t("optHeaderButton")),
              ),
              h(
                "label",
                { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" } },
                t("optAttempts"),
                h("input", {
                  key: "attempts-" + String(options.deleteAttempts),
                  type: "number",
                  min: "1",
                  max: "20",
                  step: "1",
                  defaultValue: String(options.deleteAttempts),
                  style: {
                    width: "56px",
                    font: "inherit",
                    fontSize: "12px",
                    padding: "2px 4px",
                    border: "0.5px solid rgba(0,0,0,0.2)",
                    borderRadius: "6px",
                    background: "transparent",
                    color: "inherit",
                  },
                  onBlur: function (event) {
                    var n = Math.round(Number(event.target.value));
                    if (!Number.isFinite(n)) n = 5;
                    if (n < 1) n = 1;
                    if (n > 20) n = 20;
                    setOpt("deleteAttempts", n);
                  },
                }),
              ),
            );

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "10px", minWidth: 0 } },
        h("p", { style: { margin: 0, opacity: 0.7, fontSize: "12px" } }, t("intro")),
        note !== null ? h("p", { style: { margin: 0, color: "rgb(34 197 94)", fontSize: "12px" } }, note) : null,
        failed !== null ? h("p", { style: { margin: 0, color: "rgb(239 68 68)", fontSize: "12px" } }, failed) : null,
        cfgSection,
        sorted.length === 0
          ? h("p", { style: { margin: 0, opacity: 0.6, fontSize: "12px" } }, t("empty"))
          : h(
              "div",
              {
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "2px",
                  maxHeight: "320px",
                  overflowY: "auto",
                  border: "0.5px solid rgba(0,0,0,0.12)",
                  borderRadius: "8px",
                  padding: "4px",
                },
              },
              sorted.map(function (item) {
                var id = item.sessionId;
                var title = titleOf(item);
                var isChild = item.origin === "subagent";
                return h(
                  "div",
                  {
                    key: id,
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "6px 8px",
                      borderRadius: "6px",
                      fontSize: "13px",
                    },
                  },
                  h(
                    "span",
                    { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                    title === undefined ? id : title,
                    isChild
                      ? h("span", { style: { opacity: 0.55, marginLeft: "6px", fontSize: "11px" } }, "· " + t("child"))
                      : null,
                    item.running === true
                      ? h("span", { style: { opacity: 0.55, marginLeft: "6px", fontSize: "11px" } }, "· " + t("running"))
                      : null,
                  ),
                  h(
                    "span",
                    { style: { opacity: 0.55, fontSize: "11px", whiteSpace: "nowrap" } },
                    timeOf(item.updatedAt),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      disabled: busy !== null,
                      title: t("action"),
                      onClick: function () {
                        remove(id, title === undefined ? id : title);
                      },
                      style: {
                        flex: "none",
                        border: "0.5px solid rgba(0,0,0,0.15)",
                        background: "transparent",
                        borderRadius: "6px",
                        padding: "2px 8px",
                        fontSize: "12px",
                        cursor: busy === id ? "wait" : "pointer",
                        color: "rgb(239 68 68)",
                      },
                    },
                    busy === id ? t("deleting") : "🗑 " + t("action"),
                  ),
                );
              }),
            ),
      );
    }

    /**
     * The card dispatcher: the plugins page asks for a summary row and for the
     * configuration body through the same entry.
     * @param props - Slot props.
     * @returns The element to render.
     */
    function DeleterEntry(props) {
      if (props.view === "summary") return props.t("summary");
      return h(DeleterCard, props);
    }

    /**
     * The browser half.
     * @param ctx - Client Cordis context.
     * @returns nothing.
     */
    function apply(ctx) {
      if (ctx === undefined || ctx === null || typeof ctx.inject !== "function") return;

      // The debug hook is wired separately from the card: the card needs the
      // slots and locale services, and a profile missing either must still be
      // able to delete a session by id.
      ctx.inject(["remote.settings", "remote.workspace", "remote.session"], function (owner) {
        try {
          var hookSettings = serviceAt(owner, "remote.settings");
          var hookWorkspace = serviceAt(owner, "remote.workspace");
          var hookSessions = serviceAt(owner, "remote.session");
          if (typeof window === "undefined") return;
          window.__DSH_SESSION_DELETER__ = {
            namespace: NAMESPACE,
            remote: hookSessions,
            list: function () {
              return Promise.resolve(hookSessions.list({})).then(function (result) {
                return result !== null && result !== undefined && result.ok === true
                  ? (result.value.items || []).map(function (item) {
                      return { id: item.sessionId, running: item.running, blank: item.blank };
                    })
                  : result;
              });
            },
            describe: function () {
              return Promise.resolve(hookSettings.describe()).then(function (result) {
                var view = result !== null && result !== undefined && result.ok === true ? result.value : undefined;
                return {
                  writable: view === undefined || view === null ? undefined : view.writable,
                  hasDocument: view === undefined || view === null ? undefined : view.hasDocument,
                  namespaces: (view === undefined || view === null || !Array.isArray(view.namespaces) ? [] : view.namespaces).map(function (row) {
                    return { ns: row.ns, applies: row.applies, revision: row.revision, value: row.value };
                  }),
                };
              });
            },
            delete: function (sessionId) {
              return requestDelete(
                hookSettings,
                sessionId,
                function (key) {
                  return DICTIONARY_ZH[key] === undefined ? key : DICTIONARY_ZH[key];
                },
                hookWorkspace,
              );
            },
          };
        } catch (error) {
          console.warn("session-deleter: debug hook failed", error);
        }
      });
      // The dynamic form: a missing service must not leave this fiber PENDING.
      ctx.inject(["slots", "locale", "remote.settings", "remote.session", "remote.workspace"], function (owner) {
        try {
          var slots = serviceAt(owner, "slots");
          var locale = serviceAt(owner, "locale");
          var settings = serviceAt(owner, "remote.settings");
          var sessionRemote = serviceAt(owner, "remote.session");
          var workspace = serviceAt(owner, "remote.workspace");
          if (slots === undefined || slots === null || typeof slots.inject !== "function") return;

          if (locale !== undefined && locale !== null && typeof locale.register === "function") {
            var dictionaries = function () {
              return locale.register(LOCALE_NAMESPACE, { zh: DICTIONARY_ZH, en: DICTIONARY_EN });
            };
            if (typeof owner.effect === "function") owner.effect(dictionaries, "session-deleter: dictionaries");
            else dictionaries();
          }
          var t =
            locale !== undefined && locale !== null && typeof locale.bind === "function"
              ? locale.bind(LOCALE_NAMESPACE)
              : function (key) {
                  return DICTIONARY_ZH[key] === undefined ? key : DICTIONARY_ZH[key];
                };

          var registration = null;
          var contribute = function () {
            if (registration !== null) return;
            try {
              registration = slots.inject(SLOT, function () {
                return slots.register(
                  {
                    name: SLOT,
                    id: NAMESPACE,
                    order: 70,
                    label: function () {
                      return t("title");
                    },
                    locale: LOCALE_NAMESPACE,
                    inject: function () {
                      return { runtime: React, settings: settings, sessionRemote: sessionRemote, workspace: workspace, t: t };
                    },
                  },
                  DeleterEntry,
                );
              });
            } catch (error) {
              registration = null;
              console.warn("session-deleter: card not registered", error);
            }
          };
          contribute();

          // The ⋯ menu of every session row, and a hover button on the row.
          // This is where "归档会话" lives, so "彻底删除" sits right next to it.
          try {
            slots.inject("sidebar.workspaces.session.menu.item", function () {
              return slots.register(
                {
                  name: "sidebar.workspaces.session.menu.item",
                  id: "session-deleter",
                  order: 500,
                  inject: function () {
                    return { runtime: React, settings: settings, workspace: workspace, t: t };
                  },
                },
                DeleteSessionMenuItem,
              );
            });
            slots.inject("sidebar.workspaces.session.row.action", function () {
              return slots.register(
                {
                  name: "sidebar.workspaces.session.row.action",
                  id: "session-deleter",
                  order: 200,
                  inject: function () {
                    return { runtime: React, settings: settings, workspace: workspace, t: t };
                  },
                },
                DeleteSessionRowButton,
              );
            });
          } catch (error) {
            console.warn("session-deleter: sidebar entries not registered", error);
          }

          // A button in the conversation header, so the current session can be
          // deleted from where it is being used, not only from the settings page.
          try {
            slots.inject("conversation.session.header.actions", function () {
              return slots.register(
                {
                  name: "conversation.session.header.actions",
                  id: "session-deleter",
                  order: 90,
                  inject: function () {
                    return { runtime: React, settings: settings, workspace: workspace, t: t };
                  },
                },
                DeleteCurrentButton,
              );
            });
          } catch (error) {
            console.warn("session-deleter: header action not registered", error);
          }
        } catch (error) {
          console.warn("session-deleter: card wiring failed", error);
        }
      });
    }

    exports.apply = apply;
    return module.exports;
  },
});
