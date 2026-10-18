/**
 * Maximum amount any single item stack may hold. The client renders item
 * quantities as a signed 32-bit integer, so anything above this displays as a
 * negative number. Matches live OSRS.
 */
export const MAX_STACK_AMOUNT = 0x7fffffff;

export enum StackType {
    /*
     * Default type, items that will not stack, such as inventory items (excluding noted/stackable items).
     */
    DEFAULT,
    /*
     * Stacks type, items that will stack, such as shops or banks.
     */
    STACKS,
}