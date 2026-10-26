import { MESLAYERINPUT, MESLAYERMODE } from "@runelite/api/gameval/VarClientID";
import type { BankTagsClient } from "./bankClient";
import { Bankmain, INPUT_TYPE_NONE, ScriptID } from "./bankmain";

/** RuneLite's bank plugin BankSearch: lay the bank out again, or reset its search. */
export class BankSearch {
    constructor(private readonly client: BankTagsClient) {}

    /** Runs the bank item container's inv-transmit listener (bankmain_build). */
    layoutBank(): void {
        const bankContainer = this.client.getWidget(Bankmain.ITEMS);
        if (bankContainer) this.client.runListener(bankContainer, "onInvTransmit");
    }

    reset(closeChat: boolean): void {
        // Keeps a chatbox input (the search's, say) from staying up when the tab changes.
        if (closeChat) {
            // Clears the input text and type, and lets the chatbox take input again.
            this.client.runScript(ScriptID.MESSAGE_LAYER_CLOSE, 1, 1, 0);
        } else {
            this.client.setVarcIntValue(MESLAYERMODE, INPUT_TYPE_NONE);
            this.client.setVarcStrValue(MESLAYERINPUT, "");
        }
        this.layoutBank();
    }
}
