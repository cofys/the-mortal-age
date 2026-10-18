import assert from "node:assert/strict";

import { decodeClientPacket, encodeLoginResponse } from "../../server/src/main/typescript/elvarg/net/protocol/ClientProtocol";
import { LoginIndex } from "../game/login/GameState";
import { LoginState } from "../game/login/LoginState";
import { resetClientPreferencesCache } from "../game/preferences/ClientPreferences";
import { clientEncoder } from "../network/packet/ClientBinaryEncoder";
import { decodeBatchedServerPackets, decodeServerPacket } from "../network/packet/ServerBinaryDecoder";
import { LOGIN_FLAG_REMEMBER, LOGIN_FLAG_TOKEN } from "../network/serverConnection/constants";

const store = new Map<string, string>();
const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
};
(globalThis as any).window = { localStorage, location: { hostname: "localhost" } };
(globalThis as any).localStorage = localStorage;

// The login packet carries its flags to the server.
const login = decodeClientPacket(
    Buffer.from(clientEncoder.encodeLogin("Zezima", "secret", 237, LOGIN_FLAG_REMEMBER)),
) as any;
assert.deepEqual(login, { type: "login", username: "Zezima", password: "secret", revision: 237, flags: LOGIN_FLAG_REMEMBER });

// "Log out" on the remembered-account screen sends the token to be dropped.
assert.deepEqual(
    decodeClientPacket(Buffer.from(clientEncoder.encodeLoginForget("Zezima", "tok"))) as any,
    { type: "login_forget", username: "Zezima", token: "tok" },
);

// The login response hands back the token; a server without tokens ends the packet early.
const withToken = decodeServerPacket(new Uint8Array(encodeLoginResponse(true, -1, "", "Zezima", "tok"))) as any;
assert.equal(withToken.payload.loginToken, "tok");
assert.equal(withToken.payload.displayName, "Zezima");
const legacy = Buffer.from(encodeLoginResponse(true, -1, "", "Zezima"));
const legacyBody = legacy.subarray(0, legacy.length - 1);
legacyBody[1] -= 1;
const batch = decodeBatchedServerPackets(
    new Uint8Array(Buffer.concat([legacyBody, encodeLoginResponse(false, 3, "nope", "")])),
) as any;
const [first, second] = batch.messages;
assert.equal(first.payload.loginToken, undefined, "no token, and the next packet is left alone");
assert.equal(second.payload.errorCode, 3);

// Nothing remembered: the welcome screen.
const state = new LoginState();
state.serverAddress = "localhost:43594";
state.serverTransport = "websocket";
state.showRememberedLogin();
assert.equal(state.loginIndex, LoginIndex.WELCOME);

// A remembered account shows the Play screen, on its own server only.
state.rememberLogin("Zezima", "tok");
assert.ok(!JSON.stringify([...store.values()]).includes("secret"), "the password is never stored");
state.showRememberedLogin();
assert.equal(state.loginIndex, LoginIndex.WELCOME_DISPLAY_NAME);
assert.equal(state.displayName, "Zezima");
state.serverAddress = "other.example:43594";
state.showRememberedLogin();
assert.equal(state.loginIndex, LoginIndex.WELCOME, "another server has its own remembered login");
state.serverAddress = "localhost:43594";
state.showRememberedLogin();
assert.equal(state.loginIndex, LoginIndex.WELCOME_DISPLAY_NAME);

// A login form with a typed password is never swapped out.
state.promptCredentials(false);
state.password = "typed";
state.showRememberedLogin();
assert.equal(state.loginIndex, LoginIndex.LOGIN_FORM);

state.forgetRememberedLogin();
state.loginIndex = LoginIndex.WELCOME_DISPLAY_NAME;
state.showRememberedLogin();
assert.equal(state.loginIndex, LoginIndex.WELCOME);

// The removed Remember Login plugin's password is filled in once, with "Remember username" ticked.
store.set("osrs.plugin.remember_login.v1", JSON.stringify({ enabled: true, username: "Zezima", password: "secret" }));
resetClientPreferencesCache();
const migrated = new LoginState();
assert.equal(migrated.username, "Zezima");
assert.equal(migrated.password, "secret");
assert.equal(migrated.rememberUsername, true);
migrated.clearLegacyRememberedPassword();
assert.equal(store.has("osrs.plugin.remember_login.v1"), false);

assert.notEqual(LOGIN_FLAG_TOKEN, LOGIN_FLAG_REMEMBER);
console.log("remembered login: ok");
