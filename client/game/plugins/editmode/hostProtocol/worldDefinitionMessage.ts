export const WORLD_DEFINITION_MESSAGE = "elvarg:world-definition";
export const WORLD_DEFINITION_REQUEST_MESSAGE = "elvarg:world-definition-request";
export type WorldDefinitionMessage = { type: typeof WORLD_DEFINITION_MESSAGE; contents: string };
export type WorldDefinitionRequestMessage = { type: typeof WORLD_DEFINITION_REQUEST_MESSAGE };
