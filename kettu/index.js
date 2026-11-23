(/*
 * PlatformSpoof for Kettu Android (Vendetta-family plugin format).
 * Based on the Vencord PlatformSpoof implementation in ../index.tsx.
 * Licensed GPL-3.0-or-later (see the upstream header).
 *
 * This is deliberately an IIFE expression: Kettu's Vendetta-family loader
 * evaluates the body and uses its default export without a build step.
 */
(() => {
    "use strict";

    const PLATFORMS = Object.freeze({
        off: null,
        desktop: { os: "Windows", browser: "Discord Client", device: "" },
        web: { os: "Linux", browser: "Chrome", device: "" },
        mobile: { os: "Android", browser: "Discord Android", device: "Discord Android" },
        meta: { os: "Android", browser: "Discord VR", device: "Meta Quest" },
        console: { os: "Playstation", browser: "Discord Embedded", device: "PlayStation" }
    });
    const OPTIONS = [
        ["off", "Off (normal client)"],
        ["desktop", "Desktop (Windows)"],
        ["web", "Web / Browser (Chrome)"],
        ["mobile", "Mobile (Discord Android)"],
        ["meta", "Meta Quest / VR"],
        ["console", "Console (PlayStation)"]
    ];

    const getAPI = () => typeof vendetta === "object" && vendetta !== null ? vendetta : null;
    const log = (...args) => {
        try { (getAPI()?.logger ?? console).log(...args); } catch (_) { /* optional logging */ }
    };
    const warn = (...args) => {
        try { (getAPI()?.logger ?? console).warn(...args); } catch (_) { /* optional logging */ }
    };

    let running = false;
    let selected = "mobile"; // Keep the original plugin's default.
    let originalWebSocketSend = null;
    let patchedWebSocketProto = null;
    let patchedWebSocketSend = null;
    let gatewaySocket = null;
    let originalGatewaySend = null;
    let patchedGatewaySend = null;
    let monitor = null;
    let lastObservedGatewayWebSocket = null;
    let identifyPatched = 0;
    let lastReconnectResult = "not attempted";
    let uiNotify = null;

    const validPlatform = (value) => Object.prototype.hasOwnProperty.call(PLATFORMS, value);

    function platformProperties() {
        return PLATFORMS[selected];
    }

    function rewriteIdentify(data) {
        if (!running || !platformProperties() || !data || typeof data !== "object") return false;
        const properties = data.properties ?? data.d?.properties;
        if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
        Object.assign(properties, platformProperties());
        identifyPatched++;
        return true;
    }

    function isDiscordGatewaySocket(ws) {
        const url = ws?.url ?? ws?._url ?? ws?._socketUrl;
        // Strict host test: never intercept voice/media WebSockets or unrelated apps.
        if (typeof url !== "string") return false;
        return /^wss?:\/\/gateway(?:-[a-z0-9]+)?\.discord(?:app)?\.(?:gg|com)(?::\d+)?(?:[/?#]|$)/i.test(url)
            || /^wss?:\/\/gateway\.discord\.gg(?:[/?#]|$)/i.test(url);
    }

    function rewriteSerializedIdentify(data) {
        if (typeof data !== "string" || data.length > 32768 || !data.includes('"op"')) return data;
        let packet;
        try { packet = JSON.parse(data); } catch (_) { return data; }
        if (packet?.op !== 2 || !packet?.d) return data;
        if (!rewriteIdentify(packet.d)) return data;
        return JSON.stringify(packet);
    }

    function patchWebSocket() {
        const Proto = globalThis.WebSocket?.prototype;
        if (!Proto || typeof Proto.send !== "function") return false;
        if (patchedWebSocketProto === Proto && Proto.send === patchedWebSocketSend) return true;
        if (patchedWebSocketProto) unpatchWebSocket();
        const original = Proto.send;
        const wrapped = function (data, ...rest) {
            if (running && isDiscordGatewaySocket(this)) {
                lastObservedGatewayWebSocket = this;
                data = rewriteSerializedIdentify(data);
            }
            return Reflect.apply(original, this, [data, ...rest]);
        };
        try {
            Proto.send = wrapped;
        } catch (err) {
            warn("[PlatformSpoof/Kettu] WebSocket patch failed", err);
            return false;
        }
        originalWebSocketSend = original;
        patchedWebSocketProto = Proto;
        patchedWebSocketSend = wrapped;
        return true;
    }

    function unpatchWebSocket() {
        if (patchedWebSocketProto?.send === patchedWebSocketSend) {
            patchedWebSocketProto.send = originalWebSocketSend;
        }
        patchedWebSocketProto = null;
        patchedWebSocketSend = null;
        originalWebSocketSend = null;
        lastObservedGatewayWebSocket = null;
    }

    function getGatewaySocket() {
        const find = getAPI()?.metro?.findByProps;
        if (typeof find !== "function") return null;
        try {
            const module = find("getSocket", "isConnected") ?? find("getSocket");
            const socket = module?.getSocket?.();
            // A raw WebSocket is handled by the prototype hook instead.
            if (!socket || socket instanceof globalThis.WebSocket || typeof socket.send !== "function") return null;
            return socket;
        } catch (_) { return null; }
    }

    function unpatchGatewaySocket() {
        if (gatewaySocket?.send === patchedGatewaySend) {
            gatewaySocket.send = originalGatewaySend;
        }
        gatewaySocket = null;
        originalGatewaySend = null;
        patchedGatewaySend = null;
    }

    function patchGatewaySocket() {
        const socket = getGatewaySocket();
        if (!socket) return false;
        if (socket === gatewaySocket && socket.send === patchedGatewaySend) return true;
        unpatchGatewaySocket();
        const original = socket.send;
        const wrapped = function (op, data, ...args) {
            if (op === 2) rewriteIdentify(data);
            return Reflect.apply(original, this, [op, data, ...args]);
        };
        try { socket.send = wrapped; } catch (_) { return false; }
        gatewaySocket = socket;
        originalGatewaySend = original;
        patchedGatewaySend = wrapped;
        return true;
    }

    function status() {
        return {
            running,
            platform: selected,
            websocketPatched: !!patchedWebSocketProto,
            gatewaySocketPatched: !!gatewaySocket,
            gatewayWebSocketObserved: !!lastObservedGatewayWebSocket,
            identifyPatched,
            lastReconnectResult
        };
    }

    function forceIdentify() {
        // Only reconnect if the client gateway API exposes an explicit way
        // to clear the resume session; reconnecting an arbitrary WS can RESUME.
        patchGatewaySocket();
        const socket = gatewaySocket;
        if (socket && "sessionId" in socket && (socket.webSocket || typeof socket.close === "function")) {
            try {
                socket.sessionId = null;
                if ("seq" in socket) socket.seq = 0;
                const ws = socket.webSocket;
                if (ws && typeof ws.close === "function") {
                    ws.close(1000);
                    lastReconnectResult = "gateway socket closed; re-IDENTIFY requested";
                    return true;
                }
                if (typeof socket.close === "function" && typeof socket.connect === "function") {
                    socket.close();
                    setTimeout(() => {
                        if (running) socket.connect();
                    }, 500);
                    lastReconnectResult = "gateway reconnect requested";
                    return true;
                }
            } catch (err) { warn("[PlatformSpoof/Kettu] reconnect failed", err); }
        }
        lastReconnectResult = "restart Kettu to apply (mobile gateway has no supported re-IDENTIFY API)";
        return false;
    }

    function setPlatform(next) {
        if (!validPlatform(next)) throw new Error("Unknown platform: " + next);
        if (selected === next) return;
        selected = next;
        try { getAPI().plugin.storage.platform = next; } catch (err) { warn("[PlatformSpoof/Kettu] Cannot save platform", err); }
        forceIdentify();
        uiNotify?.();
        log("[PlatformSpoof/Kettu] selected:", next, "—", lastReconnectResult);
    }

    function Settings() {
        const api = getAPI();
        const React = api?.metro?.common?.React ?? globalThis.React;
        const RN = api?.metro?.common?.ReactNative;
        if (!React || !RN) return null;
        const h = React.createElement;
        const [value, setValue] = React.useState(selected);
        const [version, updateVersion] = React.useState(0);
        React.useEffect(() => {
            const notify = () => { setValue(selected); updateVersion(n => n + 1); };
            uiNotify = notify;
            return () => { if (uiNotify === notify) uiNotify = null; };
        }, []);
        const View = RN.View;
        const Text = RN.Text;
        const Pressable = RN.Pressable ?? RN.TouchableOpacity;
        const ScrollView = RN.ScrollView ?? RN.View;
        const muted = { color: "#b0b4bf", fontSize: 12, marginBottom: 8 };
        return h(ScrollView, { style: { flex: 1, padding: 16 } },
            h(Text, { style: { fontSize: 20, fontWeight: "bold", color: "#ffffff", marginBottom: 8 } }, "PlatformSpoof — Kettu"),
            h(Text, { style: muted }, "Choose the platform Discord reports in Gateway IDENTIFY."),
            ...OPTIONS.map(([key, label]) => h(Pressable, {
                key, onPress: () => { setPlatform(key); setValue(key); updateVersion(n => n + 1); },
                accessibilityRole: "radio", accessibilityState: { checked: value === key },
                style: { padding: 13, marginBottom: 7, borderRadius: 9, borderWidth: 1,
                    borderColor: value === key ? "#5865F2" : "#404249", backgroundColor: "#292b30" }
            }, h(Text, { style: { color: value === key ? "#a8b4ff" : "#ffffff", fontSize: 15 } },
                (value === key ? "◉ " : "○ ") + label))),
            h(View, { style: { marginTop: 16 } },
                h(Text, { style: muted }, "Hook: " + (gatewaySocket ? "GatewaySocket + WebSocket" : patchedWebSocketProto ? "WebSocket (JSON)" : "not found")),
                h(Text, { style: muted }, "IDENTIFY packets modified: " + identifyPatched + "  |  " + version),
                h(Text, { style: muted }, "Change status: " + lastReconnectResult),
                h(Text, { style: muted }, "On Android the gateway may use a native transport. If the counter stays at 0, or the icon does not change, restart Kettu. If it still fails, this Discord build is not compatible with the current hook."),
                h(Pressable, { onPress: () => { forceIdentify(); updateVersion(n => n + 1); },
                    style: { backgroundColor: "#5865F2", padding: 12, borderRadius: 8, alignItems: "center", marginTop: 8 }
                }, h(Text, { style: { color: "white", fontWeight: "bold" } }, "Re-IDENTIFY (if supported)"))
            )
        );
    }

    return {
        default: {
            onLoad() {
                if (running) return;
                const saved = getAPI()?.plugin?.storage?.platform;
                selected = validPlatform(saved) ? saved : "mobile";
                running = true;
                patchWebSocket();
                patchGatewaySocket();
                // Gateway instance can be swapped as the app reconnects.
                monitor = setInterval(() => {
                    if (running) { patchWebSocket(); patchGatewaySocket(); }
                }, 2500);
                log("[PlatformSpoof/Kettu] loaded", status());
            },
            onUnload() {
                running = false;
                if (monitor !== null) clearInterval(monitor);
                monitor = null;
                unpatchGatewaySocket();
                unpatchWebSocket();
                uiNotify = null;
                log("[PlatformSpoof/Kettu] unloaded");
            },
            settings: Settings,
            // Access via the debugger, when available: plugin instance helpers.
            status,
            reconnect: forceIdentify,
            setPlatform
        }
    };
})()
)
