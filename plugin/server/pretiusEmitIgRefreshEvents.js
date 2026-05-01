(function ($, apex) {
    "use strict";

    const PLUGIN_NAME = "pretiusEmitIgRefreshEvents",
        PLUGIN_VERSION = "24.2.1",
        EVENT_NAMESPACE = "." + PLUGIN_NAME,
        DEFAULT_MAX_RETRIES = 120,
        DEFAULT_SETTLE_STABLE_CHECKS = 2,
        DEFAULT_REPORT_CHANGE_DEDUP_MS = 3000,
        DEFAULT_NO_ROWS_TAIL_SUPPRESS_MS = 250,
        DEBUG_STORAGE_KEY = PLUGIN_NAME + ".debug",
        DEBUG_OPTIONS_STORAGE_KEY = PLUGIN_NAME + ".debugOptions",
        PROCESSING_SELECTOR = ".u-Processing, .u-Processing--cellRefresh";

    const instances = {};

    function loadStoredDebugState() {
        let storedDebug,
            storedOptions;

        try {
            storedDebug = window.localStorage && window.localStorage.getItem(DEBUG_STORAGE_KEY);
            if (storedDebug === "1" || storedDebug === "true") {
                window.pretiusEmitIgRefreshEventsDebug = true;
            } else if (storedDebug === "0" || storedDebug === "false") {
                window.pretiusEmitIgRefreshEventsDebug = false;
            }

            storedOptions = window.localStorage && window.localStorage.getItem(DEBUG_OPTIONS_STORAGE_KEY);
            if (storedOptions) {
                window.pretiusEmitIgRefreshEventsDebugOptions = JSON.parse(storedOptions);
            }
        } catch (error) {
            // Ignore storage access errors (private mode / blocked storage).
        }
    }

    function persistDebugState(enabled) {
        try {
            if (window.localStorage) {
                window.localStorage.setItem(DEBUG_STORAGE_KEY, enabled ? "1" : "0");
            }
        } catch (error) {
            // Ignore storage write errors.
        }
    }

    function persistDebugOptions(options) {
        try {
            if (window.localStorage) {
                window.localStorage.setItem(DEBUG_OPTIONS_STORAGE_KEY, JSON.stringify(options || {}));
            }
        } catch (error) {
            // Ignore storage write errors.
        }
    }

    function debugInfo() {
        if (apex.debug && apex.debug.info) {
            apex.debug.info.apply(apex.debug, arguments);
        }
    }

    function debugWarn() {
        if (apex.debug && apex.debug.warn) {
            apex.debug.warn.apply(apex.debug, arguments);
        }
    }

    function isTraceEnabled() {
        return Boolean(window.pretiusEmitIgRefreshEventsDebug);
    }

    function getDebugOptions() {
        return window.pretiusEmitIgRefreshEventsDebugOptions || {};
    }

    function isVerboseSettleEnabled() {
        return Boolean(getDebugOptions().verboseSettle);
    }

    loadStoredDebugState();

    function getModelStats(state) {
        const model = state && state.model;
        let total = null,
            serverTotal = null,
            dataLength = null,
            overflow = null,
            offset = null;

        if (!model) {
            return {
                exists: false
            };
        }

        if (model._data && typeof model._data.length === "number") {
            dataLength = model._data.length;
        }

        if (typeof model.getTotalRecords === "function") {
            try {
                total = model.getTotalRecords(true);
            } catch (error) {
                total = null;
            }
        }

        if (typeof model.getServerTotalRecords === "function") {
            try {
                serverTotal = model.getServerTotalRecords();
            } catch (error) {
                serverTotal = null;
            }
        }

        if (typeof model.getDataOverflow === "function") {
            try {
                overflow = model.getDataOverflow();
            } catch (error) {
                overflow = null;
            }
        }

        if (typeof model._offset === "number") {
            offset = model._offset;
        }

        return {
            exists: true,
            dataLength: dataLength,
            total: total,
            serverTotal: serverTotal,
            overflow: overflow,
            offset: offset,
            fetching: isModelFetching(model)
        };
    }

    function traceLifecycle(state, step, details) {
        let entry,
            buffer,
            snapshot;

        if (!isTraceEnabled()) {
            return;
        }

        // Build snapshot lazily only when trace is enabled, to avoid touching transient model state.
        snapshot = {
            cycleId: state ? state.cycleId : null,
            pending: state ? state.pending : null,
            expectingRefresh: state ? state.expectingRefresh : null,
            editMode: state ? state.editMode : null,
            editModeTransitionActive: state ? state.editModeTransitionActive : null,
            refreshSuppressActive: state ? state.refreshSuppressActive : null,
            reportChangeDedupeUntil: state ? state.reportChangeDedupeUntil : null,
            reportChangeCycleSeen: state ? state.reportChangeCycleSeen : null,
            hasProcessing: state ? hasProcessing(state) : null,
            settleStableCount: state ? state.settleStableCount : null,
            settleDirty: state ? state.settleDirty : null,
            modelStats: state ? getModelStats(state) : null
        };

        entry = {
            ts: new Date().toISOString(),
            step: step,
            regionId: state ? state.regionId : null,
            details: details || {},
            state: snapshot
        };

        buffer = window.pretiusEmitIgRefreshEventsTrace;
        if (!Array.isArray(buffer)) {
            buffer = [];
            window.pretiusEmitIgRefreshEventsTrace = buffer;
        }

        buffer.push(entry);
        if (buffer.length > 1000) {
            buffer.splice(0, buffer.length - 1000);
        }

        debugInfo(PLUGIN_NAME + ": trace", entry);
        if (window.console && window.console.info) {
            window.console.info(PLUGIN_NAME + ": trace", entry);
        }
    }

    function getRegion$(regionId) {
        return $("#" + apex.util.escapeCSS(regionId), apex.gPageContext$);
    }

    function addUniqueRegionId(regionIds, regionId) {
        if (regionId && regionIds.indexOf(regionId) === -1) {
            regionIds.push(regionId);
        }
    }

    function getRegionIdsFromAffectedElements(context) {
        const affected$ = context && context.affectedElements;
        const actionSelector = context && context.action && context.action.affectedElements;
        const regionIds = [];
        let id;

        if (affected$ && affected$.length) {
            affected$.each(function () {
                addUniqueRegionId(regionIds, $(this).attr("id"));
            });
        }

        if (!regionIds.length && typeof actionSelector === "string") {
            $(actionSelector, apex.gPageContext$).each(function () {
                addUniqueRegionId(regionIds, $(this).attr("id"));
            });

            id = actionSelector.trim();
            if (id.charAt(0) === "#") {
                id = id.slice(1);
            }
            addUniqueRegionId(regionIds, id);
        }

        return regionIds;
    }

    function getRegionIdsFromSelectors(selectors) {
        const regionIds = [];
        let elements$ = $();
        let resolvedSelectors = selectors;

        if (typeof resolvedSelectors === "function") {
            resolvedSelectors = resolvedSelectors();
        }

        if (!resolvedSelectors) {
            return regionIds;
        }

        if (typeof resolvedSelectors === "string") {
            elements$ = $(resolvedSelectors, apex.gPageContext$);
        } else if (resolvedSelectors.jquery) {
            elements$ = resolvedSelectors;
        } else if (Array.isArray(resolvedSelectors)) {
            resolvedSelectors.forEach(function (selectorOrElement) {
                if (typeof selectorOrElement === "string") {
                    elements$ = elements$.add($(selectorOrElement, apex.gPageContext$));
                } else if (selectorOrElement) {
                    elements$ = elements$.add($(selectorOrElement));
                }
            });
        } else {
            elements$ = $(resolvedSelectors);
        }

        elements$.each(function () {
            addUniqueRegionId(regionIds, $(this).attr("id"));
        });

        return regionIds;
    }

    function getWidget$(regionId) {
        const region = apex.region(regionId);

        if (!region || !region.widget) {
            return null;
        }

        return region.widget();
    }

    function getCurrentView(regionId) {
        const widget$ = getWidget$(regionId);

        if (!widget$ || !widget$.length) {
            return null;
        }

        try {
            return widget$.interactiveGrid("getCurrentView");
        } catch (error) {
            return null;
        }
    }

    function hasProcessing(state) {
        return state.region$.find(PROCESSING_SELECTOR).length > 0;
    }

    function getJqEventHandlerCount(element, eventName) {
        let events;

        try {
            if (!$._data || !element) {
                return null;
            }

            events = $._data(element, "events");
            if (!events || !events[eventName]) {
                return 0;
            }

            return events[eventName].length;
        } catch (error) {
            return null;
        }
    }

    function getRefreshHandlerStats(state) {
        const regionEl = state && state.region$ && state.region$[0];
        const pageContextEl = apex.gPageContext$ && apex.gPageContext$[0] ? apex.gPageContext$[0] : document;

        return {
            beforeRegionHandlers: getJqEventHandlerCount(regionEl, "apexbeforerefresh"),
            afterRegionHandlers: getJqEventHandlerCount(regionEl, "apexafterrefresh"),
            beforePageContextHandlers: getJqEventHandlerCount(pageContextEl, "apexbeforerefresh"),
            afterPageContextHandlers: getJqEventHandlerCount(pageContextEl, "apexafterrefresh")
        };
    }

    function hasBeforeRefreshHandlers(state) {
        const stats = getRefreshHandlerStats(state);
        const regionCount = typeof stats.beforeRegionHandlers === "number" ? stats.beforeRegionHandlers : 0;
        const pageCount = typeof stats.beforePageContextHandlers === "number" ? stats.beforePageContextHandlers : 0;

        return (regionCount + pageCount) > 0;
    }

    function disconnectSettleObserver(state) {
        if (state.settleObserver) {
            state.settleObserver.disconnect();
            state.settleObserver = null;
        }
        cancelFrame(state, "settleFrameId");
        cancelFrame(state, "settleTimeoutFrameId");
        state.settleTimeoutDeadline = 0;
        state.settleCycleId = null;
    }

    function cancelFrame(state, property) {
        if (state[property]) {
            window.cancelAnimationFrame(state[property]);
            state[property] = null;
        }
    }

    function clearInitialCheckTimer(state) {
        cancelFrame(state, "initialCheckFrameId");
    }

    function clearModelBindFrame(state) {
        cancelFrame(state, "modelBindFrameId");
    }

    function clearInProgressCheckFrame(state) {
        cancelFrame(state, "inProgressCheckFrameId");
    }

    function clearStartupGuardFrame(state) {
        cancelFrame(state, "startupGuardFrameId");
    }

    function clearStartupBeforeTimer(state) {
        cancelFrame(state, "startupBeforeTimerId");
    }

    function clearInitialSyntheticTimer(state) {
        cancelFrame(state, "initialSyntheticTimerId");
    }

    function queueBeforeRefreshWhenHandlersReady(state, reason, options) {
        const config = options || {};
        const maxAttempts = typeof config.maxAttempts === "number" ? config.maxAttempts : 20;
        let warmupFrames = typeof config.warmupFrames === "number" ? config.warmupFrames : 0;
        let attempts = 0;

        clearStartupBeforeTimer(state);

        traceLifecycle(state, "before.waitForHandlers.queued", {
            reason: reason,
            warmupFrames: warmupFrames,
            maxAttempts: maxAttempts
        });

        function tryEmit() {
            state.startupBeforeTimerId = null;

            if (!instances[state.regionId] || instances[state.regionId] !== state) {
                return;
            }

            if (state.pending || !state.expectingRefresh) {
                traceLifecycle(state, "before.waitForHandlers.skipped", {
                    reason: state.pending ? "pendingAlreadyTrue" : "expectingRefreshFalse",
                    sourceReason: reason
                });
                return;
            }

            if (warmupFrames > 0) {
                warmupFrames -= 1;
                state.startupBeforeTimerId = window.requestAnimationFrame(tryEmit);
                return;
            }

            if (!hasBeforeRefreshHandlers(state) && attempts < maxAttempts) {
                attempts += 1;
                traceLifecycle(state, "before.waitForHandlers.waiting", {
                    sourceReason: reason,
                    attempt: attempts,
                    maxAttempts: maxAttempts,
                    handlers: getRefreshHandlerStats(state)
                });
                state.startupBeforeTimerId = window.requestAnimationFrame(tryEmit);
                return;
            }

            traceLifecycle(state, "before.waitForHandlers.emit", {
                sourceReason: reason,
                attempts: attempts,
                handlers: getRefreshHandlerStats(state)
            });

            triggerBeforeRefresh(state, reason);

            if (config.onEmit) {
                config.onEmit();
            }
        }

        state.startupBeforeTimerId = window.requestAnimationFrame(tryEmit);
    }

    function queueStartupGuardRelease(state) {
        let checks = 0,
            stableChecks = 0;

        clearStartupGuardFrame(state);

        function tick() {
            if (isModelFetching(state.model) || hasProcessing(state)) {
                stableChecks = 0;
            } else {
                stableChecks += 1;
            }

            if (stableChecks >= 2 || checks >= state.options.maxRetries) {
                state.startupEventGuard = false;
                state.startupGuardFrameId = null;
                return;
            }

            checks += 1;
            state.startupGuardFrameId = window.requestAnimationFrame(tick);
        }

        state.startupGuardFrameId = window.requestAnimationFrame(tick);
    }

    function clearSelectionSuppressFrame(state) {
        cancelFrame(state, "selectionSuppressFrameId");
    }

    function clearRefreshSuppression(state) {
        state.refreshSuppressActive = false;
        clearSelectionSuppressFrame(state);
    }

    function isReportChangeDedupeActive(state) {
        if (!state.reportChangeDedupeUntil) {
            return false;
        }

        if (Date.now() > state.reportChangeDedupeUntil) {
            state.reportChangeDedupeUntil = 0;
            state.reportChangeCycleSeen = false;
            return false;
        }

        return true;
    }

    function beginReportChangeDedupeWindow(state) {
        state.reportChangeDedupeUntil = Date.now() + state.options.reportChangeDedupeMs;
        state.reportChangeCycleSeen = false;
        traceLifecycle(state, "report.dedupe.begin", {
            until: state.reportChangeDedupeUntil
        });
    }

    function beginReportChangeTracking(state, source, details) {
        state.nextActionHint = "change-report";

        if (!isReportChangeDedupeActive(state)) {
            beginReportChangeDedupeWindow(state);
        }

        if (!state.awaitingReportChangeData) {
            state.awaitingReportChangeData = true;
            traceLifecycle(state, "report.awaitData.begin", Object.assign({
                source: source
            }, details || {}));
        }
    }

    function extendReportChangeDedupeWindow(state, source, reason) {
        if (!isReportChangeDedupeActive(state) || !state.reportChangeCycleSeen) {
            return;
        }

        state.reportChangeDedupeUntil = Math.max(
            state.reportChangeDedupeUntil,
            Date.now() + state.options.reportChangeDedupeMs
        );

        traceLifecycle(state, "report.dedupe.extend", {
            source: source,
            reason: reason,
            until: state.reportChangeDedupeUntil
        });
    }

    function rebindModel(state) {
        clearModelBindFrame(state);
        unsubscribeModel(state);
        state.retryCount = 0;

        window.requestAnimationFrame(function () {
            scheduleModelBind(state);
        });
    }

    function cancelPendingRefresh(state) {
        state.pending = false;
        state.expectingRefresh = false;
        state.activeAction = null;
        state.activeReason = null;
        state.nextActionHint = null;
        clearInProgressCheckFrame(state);
        disconnectSettleObserver(state);
    }

    function suppressRefreshUntilSettled(state) {
        let checks = 0,
            stableChecks = 0;

        state.refreshSuppressActive = true;
        clearSelectionSuppressFrame(state);

        function tick() {
            if (isModelFetching(state.model) || hasProcessing(state)) {
                stableChecks = 0;
            } else {
                stableChecks += 1;
            }

            if (stableChecks >= 2 || checks >= state.options.maxRetries) {
                state.refreshSuppressActive = false;
                state.selectionSuppressFrameId = null;
                return;
            }

            checks += 1;
            state.selectionSuppressFrameId = window.requestAnimationFrame(tick);
        }

        state.selectionSuppressFrameId = window.requestAnimationFrame(tick);
    }

    function resetEditFlagsAfterSave(state) {
        if (state.igInstance && typeof state.igInstance.editMode === "boolean") {
            state.editMode = state.igInstance.editMode;
        }
        state.recordEditActive = false;
        state.editModeTransitionActive = false;
        clearRefreshSuppression(state);
    }

    function getIgInstance(regionId) {
        const widget$ = getWidget$(regionId);

        if (!widget$ || !widget$.length) {
            return null;
        }

        try {
            return widget$.interactiveGrid("instance");
        } catch (error) {
            return null;
        }
    }

    function isRefreshSuppressed(state) {
        if (!state.editModeTransitionActive && state.igInstance && typeof state.igInstance.editMode === "boolean") {
            state.editMode = state.igInstance.editMode;
        }

        return Boolean(
            state.editModeTransitionActive ||
            state.refreshSuppressActive
        );
    }

    function isCompletionBlocked(state) {
        if (state.igInstance && typeof state.igInstance.editMode === "boolean") {
            state.editMode = state.igInstance.editMode;
        }

        return Boolean(state.editModeTransitionActive);
    }

    function unsubscribeModel(state) {
        if (state.model && state.originalFetch && state.model.fetch === state.patchedFetch) {
            state.model.fetch = state.originalFetch;
        }
        if (state.igInstance && state.originalPageChange && state.igInstance._pageChange === state.patchedPageChange) {
            state.igInstance._pageChange = state.originalPageChange;
        }
        if (state.igInstance && state.originalSelectionChange && state.igInstance._selectionChange === state.patchedSelectionChange) {
            state.igInstance._selectionChange = state.originalSelectionChange;
        }
        if (state.igInstance && state.originalReport && state.igInstance._report === state.patchedReport) {
            state.igInstance._report = state.originalReport;
        }
        if (state.igInstance && state.originalSetEditMode && state.igInstance._setEditMode === state.patchedSetEditMode) {
            state.igInstance._setEditMode = state.originalSetEditMode;
        }
        if (state.model && state.modelSubscriptionId && typeof state.model.unSubscribe === "function") {
            state.model.unSubscribe(state.modelSubscriptionId);
        }
        state.originalFetch = null;
        state.patchedFetch = null;
        state.originalPageChange = null;
        state.patchedPageChange = null;
        state.originalSelectionChange = null;
        state.patchedSelectionChange = null;
        state.originalReport = null;
        state.patchedReport = null;
        state.originalSetEditMode = null;
        state.patchedSetEditMode = null;
        state.igInstance = null;
        state.model = null;
        state.modelSubscriptionId = null;
    }

    function deriveActionFromReason(reason) {
        let normalized = reason || "";

        if (!normalized) {
            return "unknown";
        }

        if (normalized.indexOf("deferred:") === 0) {
            normalized = normalized.slice("deferred:".length);
        }

        if (normalized.indexOf("event.interactivegridreportchange") === 0 ||
            normalized.indexOf("report.") === 0) {
            return "change-report";
        }

        if (normalized.indexOf("model.fetch.initial") === 0 ||
            normalized.indexOf("model.initial.loaded") === 0) {
            return "initial-load";
        }

        if (normalized.indexOf("page.change") === 0) {
            return "page-change";
        }

        if (normalized.indexOf("event.apexrefresh") === 0) {
            return "manual-refresh";
        }

        if (normalized.indexOf("model.fetch") === 0) {
            return "fetch";
        }

        if (normalized.indexOf("model.refresh") === 0) {
            return "model-refresh";
        }

        if (normalized.indexOf("model.addData") === 0 ||
            normalized.indexOf("model.refreshRecords") === 0) {
            return "data-arrival";
        }

        return "unknown";
    }

    function getEventPayload(state, phase, details) {
        const reason = details && details.reason ? details.reason : null;

        return {
            plugin: PLUGIN_NAME,
            regionId: state.regionId,
            phase: phase,
            cycleId: state.cycleId,
            reason: reason,
            action: state.activeAction || deriveActionFromReason(reason),
            cycleReason: state.activeReason || reason,
            force: Boolean(details && details.force),
            timestamp: new Date().toISOString(),
            pending: state.pending,
            expectingRefresh: state.expectingRefresh,
            startupEventGuard: state.startupEventGuard,
            initialLoadPending: state.initialLoadPending,
            modelStats: getModelStats(state)
        };
    }

    function triggerBeforeRefresh(state, reason) {
        if (state.noRowsTailSuppressUntil &&
            Date.now() <= state.noRowsTailSuppressUntil) {
            traceLifecycle(state, "before.skipped.noRowsTail", {
                reason: reason,
                suppressUntil: state.noRowsTailSuppressUntil
            });
            return;
        }

        if (isRefreshSuppressed(state)) {
            traceLifecycle(state, "before.skipped.suppressed", {
                reason: reason
            });
            return;
        }

        if (isReportChangeDedupeActive(state)) {
            if (state.reportChangeCycleSeen) {
                debugInfo(PLUGIN_NAME + ": suppressed duplicate report-change refresh", {
                    regionId: state.regionId,
                    reason: reason
                });
                traceLifecycle(state, "before.skipped.reportDedupe", {
                    reason: reason
                });
                return;
            }
            state.reportChangeCycleSeen = true;
            traceLifecycle(state, "before.reportDedupe.firstCycle", {
                reason: reason
            });
        }

        if (state.pending) {
            traceLifecycle(state, "before.skipped.pending", {
                reason: reason
            });
            return;
        }

        clearInitialCheckTimer(state);
        state.pending = true;
        state.expectingRefresh = false;
        state.cycleId += 1;
        state.activeReason = reason;
        state.activeAction = state.nextActionHint || deriveActionFromReason(reason);
        state.nextActionHint = null;

        debugInfo(PLUGIN_NAME + ": apexbeforerefresh", {
            regionId: state.regionId,
            reason: reason,
            cycleId: state.cycleId
        });
        traceLifecycle(state, "before.handlers", {
            reason: reason,
            handlers: getRefreshHandlerStats(state)
        });
        traceLifecycle(state, "before.fired", {
            reason: reason
        });

        apex.event.trigger(state.region$, "apexbeforerefresh", getEventPayload(state, "before", {
            reason: reason
        }));
    }

    function finishRefresh(state, cycleId, reason, force) {
        if (!state.pending || state.cycleId !== cycleId) {
            traceLifecycle(state, "after.skipped.notPendingOrStale", {
                reason: reason,
                cycleId: cycleId,
                force: force
            });
            return;
        }

        if (isCompletionBlocked(state)) {
            state.pending = false;
            state.expectingRefresh = false;
            state.activeAction = null;
            state.activeReason = null;
            state.nextActionHint = null;
            disconnectSettleObserver(state);
            if (state.initialLoadPending) {
                completeInitialLoad(state);
            }
            traceLifecycle(state, "after.skipped.completionBlocked", {
                reason: reason,
                cycleId: cycleId,
                force: force
            });
            return;
        }

        if (!force && hasProcessing(state)) {
            traceLifecycle(state, "after.deferred.processing", {
                reason: reason,
                cycleId: cycleId
            });
            queueSettleCheck(state, reason);
            return;
        }

        // Keep report-change dedupe active through a short post-refresh tail.
        extendReportChangeDedupeWindow(state, "after", reason);

        state.pending = false;
        state.expectingRefresh = false;
        if (state.initialLoadPending) {
            completeInitialLoad(state);
        }
        disconnectSettleObserver(state);

        debugInfo(PLUGIN_NAME + ": apexafterrefresh", {
            regionId: state.regionId,
            reason: reason,
            cycleId: cycleId
        });
        traceLifecycle(state, "after.handlers", {
            reason: reason,
            handlers: getRefreshHandlerStats(state)
        });
        traceLifecycle(state, "after.fired", {
            reason: reason,
            cycleId: cycleId,
            force: force
        });

        apex.event.trigger(state.region$, "apexafterrefresh", getEventPayload(state, "after", {
            reason: reason,
            force: force
        }));

        state.activeAction = null;
        state.activeReason = null;
        state.nextActionHint = null;
    }

    function queueSettleCheck(state, reason) {
        const cycleId = state.cycleId;
        let checks = 0;

        if (state.pending &&
            state.settleCycleId === cycleId &&
            (state.settleFrameId || state.settleTimeoutFrameId)) {
            traceLifecycle(state, "settle.alreadyQueued", {
                reason: reason,
                cycleId: cycleId
            });
            return;
        }

        disconnectSettleObserver(state);
        state.settleCycleId = cycleId;
        state.settleStableCount = 0;
        state.settleDirty = false;

        if (window.MutationObserver) {
            state.settleObserver = new MutationObserver(function () {
                state.settleDirty = true;
                if (isVerboseSettleEnabled()) {
                    traceLifecycle(state, "settle.observer.dirty", {
                        reason: reason,
                        cycleId: cycleId
                    });
                }
            });

            state.settleObserver.observe(state.observeTarget, {
                childList: true,
                subtree: true,
                attributes: true
            });
        }

        traceLifecycle(state, "settle.start", {
            reason: reason,
            cycleId: cycleId,
            maxRetries: state.options.maxRetries,
            settleStableChecks: state.options.settleStableChecks
        });

        function settleTick() {
            if (!state.pending || state.cycleId !== cycleId) {
                if (isVerboseSettleEnabled()) {
                    traceLifecycle(state, "settle.tick.stopped", {
                        reason: reason,
                        cycleId: cycleId,
                        checks: checks
                    });
                }
                return;
            }

            if (hasProcessing(state) || state.settleDirty) {
                state.settleDirty = false;
                state.settleStableCount = 0;
            } else {
                state.settleStableCount += 1;
            }

            if (isVerboseSettleEnabled()) {
                traceLifecycle(state, "settle.tick", {
                    reason: reason,
                    cycleId: cycleId,
                    checks: checks,
                    stableCount: state.settleStableCount,
                    dirty: state.settleDirty
                });
            }

            if (state.settleStableCount >= state.options.settleStableChecks) {
                finishRefresh(state, cycleId, reason, false);
                return;
            }

            if (checks >= state.options.maxRetries) {
                finishRefresh(state, cycleId, reason, true);
                return;
            }

            checks += 1;
            state.settleFrameId = window.requestAnimationFrame(settleTick);
        }

        // Safety net for rare cases where settle tracking never reaches finish.
        state.settleTimeoutDeadline = Date.now() + Math.max(1000, state.options.maxRetries * 20);

        function settleTimeoutTick() {
            if (!state.pending || state.cycleId !== cycleId) {
                return;
            }

            if (Date.now() >= state.settleTimeoutDeadline) {
                if (isModelFetching(state.model) || state.awaitingReportChangeData || state.awaitingPostClearData) {
                    state.settleTimeoutDeadline = Date.now() + 1000;
                    traceLifecycle(state, "settle.timeout.extended", {
                        reason: reason,
                        cycleId: cycleId
                    });
                    state.settleTimeoutFrameId = window.requestAnimationFrame(settleTimeoutTick);
                    return;
                }

                traceLifecycle(state, "settle.timeout.force", {
                    reason: reason,
                    cycleId: cycleId
                });
                finishRefresh(state, cycleId, reason + ".timeout", true);
                return;
            }

            state.settleTimeoutFrameId = window.requestAnimationFrame(settleTimeoutTick);
        }

        traceLifecycle(state, "settle.timeout.scheduled", {
            reason: reason,
            cycleId: cycleId,
            timeoutMs: Math.max(1000, state.options.maxRetries * 20)
        });

        state.settleTimeoutFrameId = window.requestAnimationFrame(settleTimeoutTick);
        state.settleFrameId = window.requestAnimationFrame(settleTick);
    }

    function handleRefreshComplete(state, reason) {
        const stats = getModelStats(state),
            isNoRows = stats.exists &&
                (stats.serverTotal === 0 || stats.total === 0 ||
                    (stats.dataLength === 0 && !stats.overflow));

        if (isModelFetching(state.model)) {
            traceLifecycle(state, "complete.deferred.modelFetching", {
                reason: reason
            });
            return;
        }

        if (state.awaitingReportChangeData &&
            reason !== "model.addData" &&
            reason !== "model.refresh.complete" &&
            reason !== "model.refreshRecords") {
            traceLifecycle(state, "complete.deferred.awaitingReportChangeData", {
                reason: reason
            });
            return;
        }

        if (state.awaitingPostClearData &&
            reason !== "model.addData" &&
            reason !== "model.refresh.complete" &&
            reason !== "model.refreshRecords") {
            traceLifecycle(state, "complete.deferred.awaitingPostClearData", {
                reason: reason
            });
            return;
        }

        traceLifecycle(state, "complete.enter", {
            reason: reason,
            isNoRows: isNoRows
        });

        if (isCompletionBlocked(state)) {
            state.expectingRefresh = false;
            if (state.initialLoadPending) {
                completeInitialLoad(state);
            }
            traceLifecycle(state, "complete.skipped.completionBlocked", {
                reason: reason
            });
            return;
        }

        if (!state.pending) {
            if (!state.expectingRefresh) {
                traceLifecycle(state, "complete.skipped.noPendingNoExpectation", {
                    reason: reason
                });
                return;
            }
            triggerBeforeRefresh(state, "deferred:" + reason);
        }

        if (isNoRows && !isModelFetching(state.model) && !hasProcessing(state)) {
            state.noRowsTailSuppressUntil = Date.now() + state.options.noRowsTailSuppressMs;
            traceLifecycle(state, "complete.fastFinishNoRows", {
                reason: reason,
                suppressUntil: state.noRowsTailSuppressUntil
            });
            finishRefresh(state, state.cycleId, reason + ".noRows", true);
            return;
        }

        traceLifecycle(state, "complete.queueSettle", {
            reason: reason
        });

        queueSettleCheck(state, reason);
    }

    function scheduleInProgressFetchCompletion(state, reason) {
        clearInProgressCheckFrame(state);

        function tick() {
            if (!state.pending) {
                state.inProgressCheckFrameId = null;
                return;
            }

            if (isModelFetching(state.model) || hasProcessing(state)) {
                state.inProgressCheckFrameId = window.requestAnimationFrame(tick);
                return;
            }

            handleRefreshComplete(state, reason);
            state.inProgressCheckFrameId = null;
        }

        state.inProgressCheckFrameId = window.requestAnimationFrame(tick);
    }

    function attachFetchCompletionFallback(state, fetchResult, reason) {
        let handled = false;

        function done() {
            if (handled) {
                return;
            }
            handled = true;
            handleRefreshComplete(state, reason);
        }

        if (fetchResult && typeof fetchResult.always === "function") {
            fetchResult.always(done);
            return;
        }

        if (fetchResult && typeof fetchResult.then === "function") {
            fetchResult.then(done, done);
        }
    }

    function isModelFetching(model) {
        return Boolean(model && model._requestsInProgress && model._requestsInProgress.fetch);
    }

    function getModelPaginationType(model) {
        return model && model._options ? model._options.paginationType : null;
    }

    function isPagePaginationFetch(model, args) {
        const offset = args.length > 0 && typeof args[0] === "number" ? args[0] : 0;

        return getModelPaginationType(model) === "one" && offset !== (model._offset || 0);
    }

    function isInitialModelLoaded(model) {
        if (!model || isModelFetching(model) || model._data == null) {
            return false;
        }

        if (model._data.length > 0) {
            return true;
        }

        if (typeof model.getServerTotalRecords === "function" && model.getServerTotalRecords() === 0) {
            return true;
        }

        if (typeof model.getTotalRecords === "function" && model.getTotalRecords(true) === 0) {
            return true;
        }

        return typeof model.getDataOverflow === "function" && model.getDataOverflow();
    }

    function completeInitialLoad(state) {
        state.initialLoadPending = false;

        if (state.startupEventGuard) {
            queueStartupGuardRelease(state);
        }
    }

    function handleInitialLoadState(state) {
        if (!state.initialLoadPending || !state.model) {
            return;
        }

        if (isRefreshSuppressed(state)) {
            return;
        }

        if (isModelFetching(state.model)) {
            return;
        }

        if (!isInitialModelLoaded(state.model)) {
            return;
        }

        completeInitialLoad(state);
    }

    function schedulePageChangeComplete(state) {
        function pageChangeTick() {
            if (!state.pending) {
                state.initialCheckFrameId = window.requestAnimationFrame(pageChangeTick);
                return;
            }

            if (isModelFetching(state.model) || hasProcessing(state)) {
                state.initialCheckFrameId = window.requestAnimationFrame(pageChangeTick);
                return;
            }

            handleRefreshComplete(state, "page.change");
        }

        clearInitialCheckTimer(state);
        state.initialCheckFrameId = window.requestAnimationFrame(pageChangeTick);
    }

    function handleModelChange(state, changeType, change) {
        const isDataArrival = changeType === "addData" ||
            changeType === "refreshRecords" ||
            (changeType === "refresh" && change && !change.clearDataPending);

        traceLifecycle(state, "model.change", {
            changeType: changeType,
            clearDataPending: Boolean(change && change.clearDataPending),
            hasChangePayload: Boolean(change),
            modelStats: getModelStats(state)
        });

        if (state.initialLoadPending) {
            if (changeType === "refresh" && change && change.clearDataPending) {
                traceLifecycle(state, "initial.model.refresh.clearDataPending", {
                    fireOnInitialization: state.fireOnInitialization,
                    pending: state.pending
                });
                return;
            }

            if (changeType === "addData" ||
                changeType === "refreshRecords" ||
                (changeType === "refresh" && change && !change.clearDataPending)) {
                traceLifecycle(state, "initial.model.loaded", {
                    changeType: changeType,
                    fireOnInitialization: state.fireOnInitialization,
                    pending: state.pending
                });
                completeInitialLoad(state);
                if (!state.fireOnInitialization || !state.pending) {
                    traceLifecycle(state, "initial.model.loaded.exit", {
                        reason: !state.fireOnInitialization ? "fireOnInitializationDisabled" : "notPending"
                    });
                    return;
                }

                traceLifecycle(state, "initial.model.loaded.continue", {
                    reason: "pendingInitialCycle"
                });
            }
        }

        if (changeType === "refresh" && change && change.clearDataPending) {
            state.awaitingPostClearData = true;
            traceLifecycle(state, "model.awaitPostClearData.begin", {
                changeType: changeType
            });
            triggerBeforeRefresh(state, "model.refresh");
            return;
        }

        if (state.awaitingReportChangeData && isDataArrival) {
            state.awaitingReportChangeData = false;
            state.nextActionHint = null;
            traceLifecycle(state, "report.awaitData.resolved", {
                changeType: changeType
            });
        }

        if (state.awaitingPostClearData &&
            isDataArrival) {
            state.awaitingPostClearData = false;
            traceLifecycle(state, "model.awaitPostClearData.resolved", {
                changeType: changeType
            });
        }

        if (changeType === "addData") {
            handleRefreshComplete(state, "model.addData");
        } else if (changeType === "refreshRecords" && state.pending) {
            handleRefreshComplete(state, "model.refreshRecords");
        } else if (changeType === "refresh" && state.pending && (!change || !change.clearDataPending)) {
            handleRefreshComplete(state, "model.refresh.complete");
        }
    }

    function bindToCurrentModel(state) {
        const view = getCurrentView(state.regionId);
        let subscriptionId,
            originalFetch,
            igInstance,
            originalPageChange,
            originalSelectionChange,
            originalReport,
            originalSetEditMode;

        if (!view || !view.model || typeof view.model.subscribe !== "function") {
            return false;
        }

        igInstance = getIgInstance(state.regionId);

        if (state.model === view.model &&
            state.modelSubscriptionId &&
            (!state.patchedFetch || view.model.fetch === state.patchedFetch) &&
            (!igInstance || !state.patchedPageChange || igInstance._pageChange === state.patchedPageChange) &&
            (!igInstance || !state.patchedSelectionChange || igInstance._selectionChange === state.patchedSelectionChange) &&
            (!igInstance || !state.patchedReport || igInstance._report === state.patchedReport) &&
            (!igInstance || !state.patchedSetEditMode || igInstance._setEditMode === state.patchedSetEditMode)) {
            state.igInstance = igInstance;
            state.editMode = Boolean(igInstance && igInstance.editMode);
            return true;
        }

        unsubscribeModel(state);

        if (igInstance && typeof igInstance._pageChange === "function") {
            originalPageChange = igInstance._pageChange;
            state.igInstance = igInstance;
            state.editMode = Boolean(igInstance.editMode);
            state.originalPageChange = originalPageChange;
            state.patchedPageChange = function (ui) {
                if (!state.pending) {
                    triggerBeforeRefresh(state, "page.change");
                }

                originalPageChange.call(this, ui);

                schedulePageChangeComplete(state);
            };
            igInstance._pageChange = state.patchedPageChange;
        }

        if (igInstance && typeof igInstance._selectionChange === "function") {
            originalSelectionChange = igInstance._selectionChange;
            state.igInstance = igInstance;
            state.originalSelectionChange = originalSelectionChange;
            state.patchedSelectionChange = function (event) {
                if (this.editMode || state.recordEditActive || state.editMode) {
                    if (!state.pending) {
                        suppressRefreshUntilSettled(state);
                    }
                }

                return originalSelectionChange.call(this, event);
            };
            igInstance._selectionChange = state.patchedSelectionChange;
        }

        if (igInstance && typeof igInstance._report === "function") {
            originalReport = igInstance._report;
            state.igInstance = igInstance;
            state.originalReport = originalReport;
            state.patchedReport = function (pReportId) {
                if (pReportId) {
                    traceLifecycle(state, "report.patch.set", {
                        reportId: pReportId
                    });
                    beginReportChangeDedupeWindow(state);
                    beginReportChangeTracking(state, "patchedReport", {
                        reportId: pReportId
                    });
                }

                return originalReport.call(this, pReportId);
            };
            igInstance._report = state.patchedReport;
        }

        if (igInstance && typeof igInstance._setEditMode === "function") {
            originalSetEditMode = igInstance._setEditMode;
            state.igInstance = igInstance;
            state.originalSetEditMode = originalSetEditMode;
            state.patchedSetEditMode = function (pEditMode) {
                state.editModeTransitionActive = Boolean(pEditMode);
                state.editMode = Boolean(pEditMode);

                if (pEditMode) {
                    if (state.initialLoadPending) {
                        completeInitialLoad(state);
                    }
                    cancelPendingRefresh(state);
                    suppressRefreshUntilSettled(state);
                } else {
                    state.refreshSuppressActive = false;
                }

                return originalSetEditMode.call(this, pEditMode);
            };
            igInstance._setEditMode = state.patchedSetEditMode;
        }

        originalFetch = view.model.fetch;

        state.originalFetch = originalFetch;
        state.patchedFetch = function () {
            let fetchResult,
                isPageFetch = isPagePaginationFetch(this, arguments);

            traceLifecycle(state, "fetch.call", {
                isPageFetch: isPageFetch,
                initialLoadPending: state.initialLoadPending,
                startupEventGuard: state.startupEventGuard
            });

            if (state.initialLoadPending && !isPageFetch) {
                return originalFetch.apply(this, arguments);
            }

            if (state.startupEventGuard) {
                return originalFetch.apply(this, arguments);
            }

            if (!state.pending) {
                triggerBeforeRefresh(state, isPageFetch ? "page.change.fetch" : "model.fetch");
            }

            fetchResult = originalFetch.apply(this, arguments);

            if (state.pending) {
                attachFetchCompletionFallback(state, fetchResult, isPageFetch ? "page.change.fetch.complete" : "model.fetch.complete");
            }

            return fetchResult;
        };

        view.model.fetch = state.patchedFetch;

        subscriptionId = view.model.subscribe({
            viewId: PLUGIN_NAME + ":" + state.regionId,
            onChange: function (changeType, change) {
                handleModelChange(state, changeType, change);
            },
            progressView: state.region$
        });

        state.model = view.model;
        state.modelSubscriptionId = subscriptionId;
        state.observeTarget = view.view$ && view.view$.length ? view.view$[0] : state.region$[0];
        state.retryCount = 0;

        debugInfo(PLUGIN_NAME + ": subscribed to model", {
            regionId: state.regionId,
            viewId: state.modelSubscriptionId,
            currentView: view.internalIdentifier
        });

        traceLifecycle(state, "bind.initial.state", {
            fireOnInitialization: state.fireOnInitialization,
            initialLoadPending: state.initialLoadPending,
            startupEventGuard: state.startupEventGuard,
            pending: state.pending,
            isFetching: isModelFetching(state.model)
        });

        handleInitialLoadState(state);

        traceLifecycle(state, "bind.initial.afterHandle", {
            fireOnInitialization: state.fireOnInitialization,
            initialLoadPending: state.initialLoadPending,
            startupEventGuard: state.startupEventGuard,
            pending: state.pending,
            isFetching: isModelFetching(state.model)
        });

        if (state.fireOnInitialization && !state.initialEventDone) {
            if (state.initialLoadPending &&
                isModelFetching(state.model) &&
                !state.pending) {
                traceLifecycle(state, "bind.initial.triggerBefore", {
                    reason: "model.fetch.initial"
                });

                state.expectingRefresh = true;
                queueBeforeRefreshWhenHandlersReady(state, "model.fetch.initial", {
                    warmupFrames: 2,
                    maxAttempts: 20,
                    onEmit: function () {
                        if (state.pending) {
                            state.initialEventDone = true;
                            scheduleInProgressFetchCompletion(state, "model.fetch.initial.complete");
                        } else {
                            traceLifecycle(state, "bind.initial.triggerBefore.skipped", {
                                reason: "triggerBeforeRefreshDidNotSetPending"
                            });
                        }
                    }
                });
            } else if (!state.initialLoadPending && !state.pending) {
                // Defer one tick so page-level DA listeners finish binding before startup events fire.
                clearInitialSyntheticTimer(state);
                traceLifecycle(state, "bind.initial.syntheticCycle.queued", {
                    reason: "model.initial.loaded"
                });

                state.initialSyntheticTimerId = window.requestAnimationFrame(function () {
                    state.initialSyntheticTimerId = null;

                    if (!instances[state.regionId] || instances[state.regionId] !== state) {
                        return;
                    }

                    if (state.initialEventDone || state.pending) {
                        traceLifecycle(state, "bind.initial.syntheticCycle.skipped", {
                            reason: state.initialEventDone ? "initialEventAlreadyDone" : "pendingAlreadyTrue"
                        });
                        return;
                    }

                    traceLifecycle(state, "bind.initial.syntheticCycle.start", {
                        reason: "model.initial.loaded"
                    });
                    triggerBeforeRefresh(state, "model.initial.loaded");
                    if (state.pending) {
                        state.initialEventDone = true;
                        finishRefresh(state, state.cycleId, "model.initial.loaded", true);
                    } else {
                        traceLifecycle(state, "bind.initial.syntheticCycle.skipped", {
                            reason: "triggerBeforeRefreshDidNotSetPending"
                        });
                    }
                });
            } else {
                traceLifecycle(state, "bind.initial.deferred", {
                    fireOnInitialization: state.fireOnInitialization,
                    initialLoadPending: state.initialLoadPending,
                    isFetching: isModelFetching(state.model),
                    pending: state.pending
                });
            }
        } else {
            traceLifecycle(state, "bind.initial.notTriggered", {
                fireOnInitialization: state.fireOnInitialization,
                initialLoadPending: state.initialLoadPending,
                isFetching: isModelFetching(state.model),
                pending: state.pending,
                initialEventDone: state.initialEventDone,
                reason: !state.fireOnInitialization ? "fireOnInitializationDisabled" : "initialEventAlreadyDone"
            });
        }

        if (!state.startupEventGuard && !state.initialLoadPending && isModelFetching(state.model) && !state.pending) {
            triggerBeforeRefresh(state, "model.fetch.inProgress");
            if (state.pending) {
                scheduleInProgressFetchCompletion(state, "model.fetch.inProgress.complete");
            }
        }

        return true;
    }

    function scheduleModelBind(state) {
        clearModelBindFrame(state);

        if (bindToCurrentModel(state)) {
            return;
        }

        if (state.retryCount >= state.options.maxRetries) {
            debugWarn(PLUGIN_NAME + ": unable to subscribe to IG model", {
                regionId: state.regionId
            });
            return;
        }

        state.retryCount += 1;
        state.modelBindFrameId = window.requestAnimationFrame(function () {
            scheduleModelBind(state);
        });
    }

    function destroyInstance(regionId) {
        const state = instances[regionId];

        if (!state) {
            return;
        }

        state.region$.off(EVENT_NAMESPACE + "." + regionId);
        disconnectSettleObserver(state);
        clearInitialCheckTimer(state);
        clearModelBindFrame(state);
        clearInProgressCheckFrame(state);
        clearStartupGuardFrame(state);
        clearStartupBeforeTimer(state);
        clearInitialSyntheticTimer(state);
        clearSelectionSuppressFrame(state);
        unsubscribeModel(state);

        delete instances[regionId];
    }

    function initRegion(regionId, options) {
        const region$ = getRegion$(regionId);
        const config = options || {};
        const region = apex.region(regionId);
        let state;

        if (!region$.length) {
            debugWarn(PLUGIN_NAME + ": region not found", {
                regionId: regionId,
                source: "render"
            });
            return false;
        }

        if (!region || region.type !== "InteractiveGrid") {
            debugWarn(PLUGIN_NAME + ": affected region is not an Interactive Grid", regionId);
            return false;
        }

        destroyInstance(regionId);

        state = {
            regionId: regionId,
            region$: region$,
            observeTarget: region$[0],
            model: null,
            modelSubscriptionId: null,
            igInstance: null,
            originalFetch: null,
            patchedFetch: null,
            originalPageChange: null,
            patchedPageChange: null,
            originalSelectionChange: null,
            patchedSelectionChange: null,
            originalReport: null,
            patchedReport: null,
            originalSetEditMode: null,
            patchedSetEditMode: null,
            settleObserver: null,
            settleFrameId: null,
            settleTimeoutFrameId: null,
            settleTimeoutDeadline: 0,
            settleCycleId: null,
            settleDirty: false,
            settleStableCount: 0,
            initialCheckFrameId: null,
            modelBindFrameId: null,
            inProgressCheckFrameId: null,
            selectionSuppressFrameId: null,
            startupGuardFrameId: null,
            startupBeforeTimerId: null,
            cycleId: 0,
            pending: false,
            expectingRefresh: false,
            editModeTransitionActive: false,
            editMode: false,
            recordEditActive: false,
            refreshSuppressActive: false,
            initialLoadPending: true,
            startupEventGuard: true,
            retryCount: 0,
            activeAction: null,
            activeReason: null,
            nextActionHint: null,
            awaitingReportChangeData: false,
            awaitingPostClearData: false,
            reportChangeDedupeUntil: 0,
            reportChangeCycleSeen: false,
            noRowsTailSuppressUntil: 0,
            fireOnInitialization: Boolean(config.fireOnInitialization),
            initialEventDone: false,
            initialSyntheticTimerId: null,
            options: {
                maxRetries: DEFAULT_MAX_RETRIES,
                settleStableChecks: DEFAULT_SETTLE_STABLE_CHECKS,
                reportChangeDedupeMs: DEFAULT_REPORT_CHANGE_DEDUP_MS,
                noRowsTailSuppressMs: DEFAULT_NO_ROWS_TAIL_SUPPRESS_MS
            }
        };

        instances[regionId] = state;

        traceLifecycle(state, "init.region", {
            fireOnInitialization: state.fireOnInitialization,
            executeOnPageInit: config.executeOnPageInit,
            browserEvent: config.browserEvent
        });

        region$
            .on("apexrefresh" + EVENT_NAMESPACE + "." + regionId, function () {
                traceLifecycle(state, "event.apexrefresh.received", {
                    startupEventGuard: state.startupEventGuard,
                    fireOnInitialization: state.fireOnInitialization,
                    pending: state.pending,
                    expectingRefresh: state.expectingRefresh
                });

                if (state.startupEventGuard && !state.fireOnInitialization) {
                    traceLifecycle(state, "event.apexrefresh.startupGuardBlocked", {
                        reason: "startupEventGuardWithoutInitialization"
                    });
                    scheduleModelBind(state);
                    return;
                }

                state.expectingRefresh = true;

                if (state.startupEventGuard && !state.pending) {
                    state.expectingRefresh = true;
                    traceLifecycle(state, "event.apexrefresh.startupBefore.queued", {
                        warmupFrames: 2
                    });

                    queueBeforeRefreshWhenHandlersReady(state, "event.apexrefresh.startup", {
                        warmupFrames: 2,
                        maxAttempts: 20
                    });
                }

                if (!state.pending && !state.startupEventGuard) {
                    triggerBeforeRefresh(state, "event.apexrefresh");
                }
                scheduleModelBind(state);
            })
            .on("apexbeginrecordedit" + EVENT_NAMESPACE + "." + regionId, function () {
                state.editModeTransitionActive = false;
                state.recordEditActive = true;
                cancelPendingRefresh(state);
            })
            .on("apexendrecordedit" + EVENT_NAMESPACE + "." + regionId, function () {
                state.editModeTransitionActive = false;
                state.recordEditActive = false;
            })
            .on("interactivegridselectionchange" + EVENT_NAMESPACE + "." + regionId, function () {
                const isEditing = state.editMode || (state.igInstance && state.igInstance.editMode);

                if (!isEditing) {
                    state.recordEditActive = false;
                    return;
                }

                if (state.recordEditActive || isEditing) {
                    if (!state.pending) {
                        suppressRefreshUntilSettled(state);
                    }
                }
            })
            .on("interactivegridreportchange" + EVENT_NAMESPACE + "." + regionId, function () {
                if (state.startupEventGuard) {
                    window.requestAnimationFrame(function () {
                        scheduleModelBind(state);
                    });
                    return;
                }

                traceLifecycle(state, "event.interactivegridreportchange", {});
                beginReportChangeTracking(state, "reportChangeEvent");
                state.expectingRefresh = true;
                if (!state.pending) {
                    triggerBeforeRefresh(state, "event.interactivegridreportchange");
                }
                window.requestAnimationFrame(function () {
                    scheduleModelBind(state);
                });
            })
            .on("interactivegridsave" + EVENT_NAMESPACE + "." + regionId, function () {
                resetEditFlagsAfterSave(state);

                cancelPendingRefresh(state);
                rebindModel(state);
            })
            .on("interactivegridmodechange" + EVENT_NAMESPACE + "." + regionId, function (event, data) {
                state.editMode = Boolean(data && data.editMode);
                state.editModeTransitionActive = false;
                if (state.editMode) {
                    cancelPendingRefresh(state);
                } else {
                    state.recordEditActive = false;
                    clearRefreshSuppression(state);
                }
            })
            .on("interactivegridviewchange" + EVENT_NAMESPACE + "." + regionId, function () {
                window.requestAnimationFrame(function () {
                    scheduleModelBind(state);
                });
            });

        scheduleModelBind(state);
        return true;
    }

    function render() {
        const regionIds = getRegionIdsFromAffectedElements(this);
        const affectedRegionId = this.action && this.action.affectedRegionId;
        const executeOnPageInit = Boolean(this.action && this.action.executeOnPageInit);
        const browserEvent = this && this.browserEvent;
        const isLoadEvent = browserEvent === "load" || (browserEvent && browserEvent.type === "load");
        const fireOnInitialization = Boolean(executeOnPageInit || isLoadEvent);
        let initializedCount = 0,
            i;

        debugInfo(PLUGIN_NAME + ": render context", {
            regionIds: regionIds,
            affectedRegionId: affectedRegionId,
            executeOnPageInit: executeOnPageInit,
            fireOnInitialization: fireOnInitialization,
            browserEvent: browserEvent,
            isLoadEvent: isLoadEvent
        });

        if (Array.isArray(affectedRegionId)) {
            for (i = 0; i < affectedRegionId.length; i += 1) {
                addUniqueRegionId(regionIds, affectedRegionId[i]);
            }
        } else {
            addUniqueRegionId(regionIds, affectedRegionId);
        }

        if (!regionIds.length) {
            debugInfo(PLUGIN_NAME + ": region not found", {
                regionIds: regionIds,
                affectedElements: this && this.affectedElements,
                actionAffectedElements: this && this.action ? this.action.affectedElements : null,
                affectedRegionId: affectedRegionId
            });
            return 0;
        }

        for (i = 0; i < regionIds.length; i += 1) {
            if (initRegion(regionIds[i], {
                fireOnInitialization: fireOnInitialization,
                executeOnPageInit: executeOnPageInit,
                browserEvent: browserEvent
            })) {
                initializedCount += 1;
            }
        }

        if (!initializedCount) {
            debugWarn(PLUGIN_NAME + ": no Interactive Grid region initialized", {
                regionIds: regionIds
            });
        }

        return initializedCount;
    }

    function activate(selectors, options) {
        const config = options || {};
        const regionIds = getRegionIdsFromSelectors(selectors);
        const explicitExecuteOnPageInit = Object.prototype.hasOwnProperty.call(config, "executeOnPageInit");
        const explicitBrowserEvent = Object.prototype.hasOwnProperty.call(config, "browserEvent");
        let affectedElements$ = $();
        let executeOnPageInit = Boolean(config.executeOnPageInit),
            browserEvent,
            shouldTreatAsInitialization,
            i;

        if (!regionIds.length) {
            debugWarn(PLUGIN_NAME + ": no regions matched selectors", {
                selectors: selectors
            });
            return 0;
        }

        for (i = 0; i < regionIds.length; i += 1) {
            affectedElements$ = affectedElements$.add(getRegion$(regionIds[i]));
        }

        shouldTreatAsInitialization = regionIds.some(function (regionId) {
            return !instances[regionId];
        });

        if (!explicitExecuteOnPageInit) {
            executeOnPageInit = shouldTreatAsInitialization;
        }

        browserEvent = explicitBrowserEvent
            ? config.browserEvent
            : (executeOnPageInit ? "load" : null);

        return render.call({
            affectedElements: affectedElements$,
            action: {
                affectedRegionId: regionIds,
                executeOnPageInit: executeOnPageInit,
                affectedElements: typeof selectors === "string" ? selectors : null
            },
            browserEvent: browserEvent
        });
    }

    window.pretiusEmitIgRefreshEvents = {
        render: render,
        activate: activate,
        getVersion: function () {
            return PLUGIN_VERSION;
        },
        destroy: destroyInstance,
        clearTrace: function () {
            window.pretiusEmitIgRefreshEventsTrace = [];
        },
        getTrace: function () {
            return window.pretiusEmitIgRefreshEventsTrace || [];
        },
        enableDebug: function () {
            window.pretiusEmitIgRefreshEventsDebug = true;
            persistDebugState(true);
        },
        disableDebug: function () {
            window.pretiusEmitIgRefreshEventsDebug = false;
            persistDebugState(false);
        },
        setDebugOptions: function (options) {
            window.pretiusEmitIgRefreshEventsDebugOptions = options || {};
            persistDebugOptions(window.pretiusEmitIgRefreshEventsDebugOptions);
        },
        getDebugOptions: function () {
            return getDebugOptions();
        }
    };

})(apex.jQuery, apex);