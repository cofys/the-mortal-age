import type { PluginMessagePayload } from "../../../common/network/PluginMessage";

/**
 * A message for plugins. From the server it has a channel and data; between client plugins it is
 * RuneLite's PluginMessage(namespace, name, data), e.g. new PluginMessage("shortestpath", "path", {...}).
 */
export class PluginMessage {
    readonly channel: string;
    /** RuneLite's message name; empty for server messages. */
    readonly name: string;
    readonly data: PluginMessagePayload["data"];

    constructor(channel: string, data: PluginMessagePayload["data"]);
    constructor(namespace: string, name: string, data?: PluginMessagePayload["data"]);
    constructor(channel: string, nameOrData: string | PluginMessagePayload["data"], data?: PluginMessagePayload["data"]) {
        this.channel = channel;
        if (typeof nameOrData === "string") {
            this.name = nameOrData;
            this.data = data ?? {};
        } else {
            this.name = "";
            this.data = nameOrData;
        }
    }

    /** RuneLite's getNamespace(): the channel. */
    get namespace(): string {
        return this.channel;
    }
}
