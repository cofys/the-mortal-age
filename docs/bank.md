# Bank

## Messages (rsprox captures)

| Action | Message | Recordings |
| --- | --- | --- |
| Withdraw with no free inventory slot | `You don't have enough inventory space.` | 454, 3066 |
| Withdraw more unstackable items than there are free slots (the rest are taken) | `You don't have enough inventory space to withdraw that many.` | 4151, 3467 |
| Click the empty slot after the last tab | `To create a new tab, drag items from your bank onto this tab.` | 1059 |

Our code does not shorten a withdrawal of a stackable item or of a noted one, so those send neither message; I did not check that against a recording.

Not yet implemented, seen live: `Some of your items cannot be stored in the bank.` on Deposit inventory
(recording 717), and `Upgrade to a Jagex Account to unlock more bank space.` (recording 1636).
