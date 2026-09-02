// Railway Keepalive
// Sends a heartbeat request to the server every 4:30, but only while this
// browser tab is open and visible. This keeps Railway's serverless "sleep"
// feature from putting the container down while you're actively reading or
// using SillyTavern, without keeping it awake 24/7.

const { extensionSettings, saveSettingsDebounced, eventSource, event_types } = SillyTavern.getContext();

const MODULE_NAME = 'railway_keepalive';
const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000 + 30 * 1000; // 4:30

// NOTE: extensionSettings are stored client-side in plain text and are
// readable by any other installed extension. This token is a speed bump
// against blind probing of the /ping route, not a real secret - don't reuse
// a password or API key here.
const defaultSettings = Object.freeze({
    enabled: true,
    token: '',
});

function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

// This must hit the railway-keepalive SERVER PLUGIN, not just any SillyTavern
// route. A plain request/response to SillyTavern is inbound traffic and does
// NOT reset Railway's sleep timer - only a genuine outbound request that the
// container itself initiates does. The plugin's /ping route makes that
// outbound request server-side before responding.
const KEEPALIVE_ENDPOINT = '/api/plugins/railway-keepalive/ping';

let pendingTimeout = null;
// Treat "never sent" as due-now rather than waiting a full interval on first visibility.
let lastHeartbeatAt = 0;

async function sendHeartbeat() {
    try {
        const settings = getSettings();
        const params = new URLSearchParams({ _t: String(Date.now()) });
        if (settings.token) {
            params.set('token', settings.token);
        }
        const response = await fetch(`${window.location.origin}${KEEPALIVE_ENDPOINT}?${params.toString()}`, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
        });
        if (!response.ok) {
            console.warn(`[${MODULE_NAME}] heartbeat endpoint returned ${response.status} - is the server plugin installed and enableServerPlugins set to true?`);
            return;
        }
        console.debug(`[${MODULE_NAME}] heartbeat sent`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] heartbeat failed`, error);
    } finally {
        // Record the attempt time regardless of success, so a persistently
        // failing endpoint doesn't cause rapid retry-looping.
        lastHeartbeatAt = Date.now();
    }
}

// Schedules the next heartbeat based on how much time has actually elapsed
// since the last one - NOT a flat interval from "now". This matters because
// the tab can go hidden and become visible again before a full interval has
// passed; in that case we want to catch up immediately (if overdue) rather
// than waiting another full 4:30 and risking Railway sleeping in the gap.
function scheduleNext() {
    clearPending();

    const elapsed = Date.now() - lastHeartbeatAt;
    const delay = Math.max(0, HEARTBEAT_INTERVAL_MS - elapsed);

    pendingTimeout = setTimeout(async () => {
        await sendHeartbeat();
        if (document.visibilityState === 'visible' && getSettings().enabled) {
            scheduleNext();
        }
    }, delay);
}

function clearPending() {
    if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingTimeout = null;
    }
}

function refreshState() {
    const settings = getSettings();
    if (settings.enabled && document.visibilityState === 'visible') {
        console.log(`[${MODULE_NAME}] active (tab visible)`);
        scheduleNext();
    } else {
        console.log(`[${MODULE_NAME}] paused (tab hidden or disabled)`);
        clearPending();
    }
}

function addSettingsUI() {
    if (document.getElementById('railway_keepalive_enabled')) {
        return; // already added (e.g. APP_READY fired twice)
    }

    const settings = getSettings();
    const html = `
    <div class="railway-keepalive-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Railway Keepalive</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="railway_keepalive_enabled">
                    <input id="railway_keepalive_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
                    <span>Send a heartbeat every 4:30 while this tab is open and visible (requires the "railway-keepalive" server plugin to be installed)</span>
                </label>
                <label for="railway_keepalive_token">
                    <span>Shared token (must match the RAILWAY_KEEPALIVE_TOKEN env var on the server, if set)</span>
                </label>
                <input id="railway_keepalive_token" type="password" class="text_pole" value="${settings.token}" placeholder="Optional, but recommended" />
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    $('#railway_keepalive_enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        refreshState();
    });

    $('#railway_keepalive_token').on('input', function () {
        settings.token = $(this).val();
        saveSettingsDebounced();
    });
}

eventSource.on(event_types.APP_READY, () => {
    addSettingsUI();
    document.addEventListener('visibilitychange', refreshState);
    refreshState();
});