# Lil' Zik dust and physical forms

Stacked on #1418's physical-form family/storage support. Sanguine dust Use consumes one item on the owned, registered current follower and permanently unlocks its family. Carrying dust does not bypass Use; wrong dust, foreign followers, stale slots, dead/trading players and delayed Bank transfers cannot consume it. Olmlet and Lil' Zik have independent family keys.

| Form | Item gameval / ID | Follower gameval / ID |
| --- | --- | --- |
| Lil' Zik | verzikpet /22473 | verzik_pet /8337 |
| Lil' Maiden | maidenpet /25748 | verzik_pet_maiden /10870 |
| Lil' Bloat | bloatpet /25749 | verzik_pet_bloat /10871 |
| Lil' Nylo | nylocaspet /25750 | verzik_pet_nylocas /10872 |
| Lil' Sot | sotetsegpet /25751 | verzik_pet_sotetseg /10873 |
| Lil' Xarp | xarpuspet /25752 | verzik_pet_xarpus /10874 |

## Evidence and limits

- Actual populated RSProx index, `facts verzik_pet`, two Metamorphosis op3 attempts in229/2783 and239/4288: locked refusal at+0. `trace verzik_pet --action 1 --rec 4288` confirms the line. Alternate followers appear in recordings, but successful selection order/presentation is not established.
- [Lil' Zik](https://oldschool.runescape.wiki/w/Lil%27_Zik) and [Sanguine dust](https://oldschool.runescape.wiki/w/Sanguine_dust): five alternates, native dust Use and item-statement transcript. [Hard Mode rewards](https://oldschool.runescape.wiki/w/Theatre_of_Blood/Hard_Mode#Rewards) require Hard Mode plus the target-time condition for dust rolls. Natural acquisition is a separate unimplemented raid/reward dependency; no normal-mode dust award or free unlock is added here. QA dust was deliberately seeded.
- Matching cache241 and [pinned dump6e5033af](https://github.com/Joshua-F/osrs-dumps/tree/6e5033af6215963581a51b348f452320ff18f0f6): six item/follower pairs, native operations, `tob_hardmode_dust`25746, menagerie enum3856 and `poh_menagerie_multiform_verzikpet`12235. POH-only NPC copies10761–10765 are not field followers.
- The existing one-step Metamorphosis cycle is extended; exact official field selector presentation/order remains unverified. No new selector or pet conversation is invented. Capture-backed generic pickup sound delay and cache-backed display names remain separate interaction follow-ups.

## Production path and ownership

Native item-on-NPC → real queued route/slot revalidation → Dust.Pets owned/current/registered/live-state checks → exact single-item consumption → persistent `item:22473` unlock → save and real ItemStatement dialogue. The shared handler chooses a dust/family pair before consuming anything.

Native NPC operation → Pets.handlePetClick → captured locked refusal or guarded morph. Each form has its actual item, canonical family22473, base collection entry and active/last marker. Pickup uses the real inventory; Bank and PlayerSave retain physical identity. Probita locates the whole family, then returns the recorded item. Menagerie resolves the same family through enum985/3856, preserving its distinct icon/roaming form/Take item and PIN/session safeguards from #1418.

## Verification

- Build passed. Initial12 native tests reproduced9 failures before implementation; final16 new tests and combined real feature/foundation checks76/76 pass. Full frozen-source suite **9,232/9,232**, zero failures/skips.
- Real Player/Inventory/Bank/NPC/ClientConnection/PlayerSave/PlayerHouseInstance and all startup hooks. Native dust refusal/Use, all six Drop/Pick-up pairs, repeat use, queued Bank transfer, actual trade interruption, dead/foreign/wrong-dust refusal, base collection entry, Probita, active save/login, menagerie icon/roaming/Take. Only network output captured.
- Independent Codex build and70/70 real checks; additional normal-ToB acquisition/delivery9/9. Reviewer chose real two-family Bank/save/restore and simultaneous menagerie transitions: wrong Sanguine dust cannot unlock Olmlet; taking Lil' Xarp preserves stored/roaming Flying Vespina and both family keys. A real generated normal raid roll and native own-vault Open respect already-owned banked Lil' Xarp, consume the pending base pet entry and do not mint another copy. RNG0 only forced that reward roll.
- Actual browser: native Sanguine dust Use displayed correct icon/text and left one of two dust; native Lil' Zik Metamorphosis selected Lil' Maiden. All five alternate follower models inspected and screenshotted. Native Lil' Xarp pickup returned25752; native menagerie View displayed its item icon with varbit12235=5 and native Take returned one25752, cleared storage and roaming NPC. Seeded item/MaxHouse setup stayed in the disposable QA profile.
- Full suite retains independently reproduced nonfailing Adventure Paths Hunter/WarpedSceptre null-core lifecycle warnings from unchanged upstream fixtures; critical real Pets/reviewer paths emitted none.
- Reviewed base c85c23b01a43249570dc8d8b084a115c8522db76; diff SHA256 D6F7C35894A3166A24CF3883B2457DA231E6897917CBE900FF7FA92E026E645F; Pets89367CE305D3FDF27F8731794D2AF22F964D621764A77D272F7920060BD6BC22; Dust27CF90E6A55F32029B63A5C72F9794382456EA0830AA23A3802ABDB10368431D; new tests6748FDEB5FCE4887238773C22DC8660147C23A4B761B007D0E34FE9463C32E67.
