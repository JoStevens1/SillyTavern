// Railway Keepalive - server plugin
//
// Railway's "Serverless" sleep feature only resets its idle timer on
// OUTBOUND traffic that the container itself initiates (DB pings, telemetry,
// calls to other hosts). Traffic arriving at the container - including a
// browser's request and the response SillyTavern sends back - is classified
// as inbound and does NOT reset the timer.
//
// This plugin exposes an endpoint that, when hit, makes a small outbound
// HTTP request to an external host before responding. That outbound request
// is what actually keeps Railway from sleeping the service. Pair this with
// the "Railway Keepalive" client extension, which calls this endpoint every
// 4:30 but only while the SillyTavern tab is open and visible.

// Lightweight, low-payload endpoint commonly used for connectivity checks.
// Returns 204 with no body, so the request is cheap on both ends.
const KEEPALIVE_TARGET = 'https://connectivitycheck.gstatic.com/generate_204';
const KEEPALIVE_TIMEOUT_MS = 5000;

// Defense in depth only - this does NOT replace verifying that your
// whitelist/basicAuth/CSRF middleware actually covers plugin routes.
// If set, requests must include a matching `?token=` value or they're
// rejected before any outbound call is made. Leave unset to disable this
// check (not recommended if the endpoint could ever be reached directly).
const SHARED_TOKEN = process.env.RAILWAY_KEEPALIVE_TOKEN || '';

// Refuse to actually fire the outbound ping more often than this, regardless
// of how many requests hit the endpoint. Caps abuse/cost if someone finds
// and spams this route, and avoids hammering the external target.
const MIN_PING_INTERVAL_MS = 60 * 1000;
let lastPingAt = 0;

/**
 * @param {import('express').Router} router Express router
 * @returns {Promise<void>}
 */
async function init(router) {
    router.get('/ping', async (req, res) => {
        if (SHARED_TOKEN && req.query.token !== SHARED_TOKEN) {
            return res.sendStatus(403);
        }

        const now = Date.now();
        if (now - lastPingAt < MIN_PING_INTERVAL_MS) {
            // Too soon since the last real outbound ping - no-op, but still
            // respond 200 so the client extension doesn't treat it as broken.
            return res.sendStatus(200);
        }
        lastPingAt = now;

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), KEEPALIVE_TIMEOUT_MS);

            await fetch(KEEPALIVE_TARGET, {
                method: 'HEAD',
                signal: controller.signal,
            }).finally(() => clearTimeout(timeout));

            console.log('[railway-keepalive] outbound ping sent');
            res.sendStatus(200);
        } catch (error) {
            // Even if the outbound call fails (e.g. transient network issue),
            // don't error out to the client - just log it.
            console.warn('[railway-keepalive] outbound ping failed:', error.message);
            res.sendStatus(200);
        }
    });

    if (!SHARED_TOKEN) {
        console.warn('[railway-keepalive] RAILWAY_KEEPALIVE_TOKEN is not set - /ping is reachable by anyone who can reach this route at all. Set it as an env var and configure the same value in the client extension settings.');
    }

    console.log('[railway-keepalive] plugin loaded');
    return Promise.resolve();
}

async function exit() {
    return Promise.resolve();
}

module.exports = {
    init,
    exit,
    info: {
        id: 'railway-keepalive',
        name: 'Railway Keepalive',
        description: 'Exposes an endpoint that triggers a genuine outbound request, used to prevent Railway serverless sleep on demand.',
    },
};