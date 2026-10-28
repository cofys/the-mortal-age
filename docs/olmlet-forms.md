# Olmlet physical forms

Eight follower/item pairs now share the existing `item:20851` family. The permanent dust unlock and legacy variant map keep their keys; collection progress uses the base Olmlet entry. Explicit variant items summon their own form rather than another copy's most recently chosen preference.

| Form | Cache item | Cache follower |
| --- | --- | --- |
| Olmlet | olmpet20851 | raids_olm_pet7520 |
| Puppadile | dogadilepet22376 | dogadile_pet8201 |
| Tektiny | tektonpet22378 | tekton_pet8202 |
| Enraged Tektiny | tektonenragedpet24656 | tekton_enraged_pet9513 |
| Vanguard | vanguardpet22380 | vanguard_pet8203 |
| Vasa Minirio | vasapet22382 | vasa_pet8204 |
| Vespina | vespulapet22384 | vespula_pet8205 |
| Flying Vespina | vespulaflyingpet24658 | vespula_flying_pet9514 |

## Sources and limits

- [Olmlet](https://oldschool.runescape.wiki/w/Olmlet), [Metamorphosis](https://oldschool.runescape.wiki/w/Metamorphosis) and the [28 May2020 update](https://oldschool.runescape.wiki/w/Update:Chambers_of_Xeric_Improvements): forms and existing dust unlock. No rates changed.
- [Pinned cache241 dump](https://github.com/Joshua-F/osrs-dumps/tree/6e5033af6215963581a51b348f452320ff18f0f6) and active cache: item symbols, follower rather than POH NPC copies, actions, models and enum1711. `poh_menagerie_drawpet` uses that enum with `poh_menagerie_multiform_olmpet`; new forms are enum6/7.
- Actual populated RSProx index: Puppadile appears in46 recordings, Enraged Tektiny16, Flying Vespina26, but `facts` reports no player actions on these NPCs. This confirms appearances/IDs, not selection behaviour. Earlier searches accidentally used an empty working-directory index; those negative results were discarded and repeated in the actual capture directory.
- Original OSRS dust clips inspected did not establish a transformation selector. The existing one-step field cycle is extended with the two alternates adjacent to their normal forms. Exact official field selection presentation/order remains unverified; this is not a claim of complete interaction parity. No new menu or transcript is invented.
- Menagerie PIN guards follow this repository's shared-storage review requirement; a menagerie-specific official PIN interaction was not established by the Wiki/captures.

## Production path and state owners

- Native inventory Drop → ClientConnection → item-drop policy → Pets.drop → real NPC/follower state. Physical form metadata selects the NPC. Legacy base ownership plus a valid saved variant migrates to the chosen physical form; new ownership records then disambiguate separately held base copies.
- Native NPC operation → shared NPC dispatcher → Pets.morph/pickup. Metamorphosis records the current physical item for ownership/recovery and updates follower config448. Pickup delivers that item; full inventory and foreign ownership cannot mint a copy. Repeat dust Use recognises the family on alternate forms.
- Probita's native148 row/Confirm → Recovery.Pets → canonical family ownership and live possession → real Inventory. Legacy lost records resolve the old chosen form before the first new summon. The collection service still sees20851 only.
- Native item-on-object → queued real walk → Menagerie.storePet → captured item-slot identity/live player/standing furniture checks → shared Bank PIN guard → exact slot consumption. One family occupies one enum985 slot; `construction:menagerie-forms` remembers the physical item. Cache param446 provides the enum for the client form varbit. View211, withdrawal and roaming use that same stored form.
- Native211 withdrawal requires its live modal and current owned house, then rechecks stored form, origin, capacity and PIN resume. Logout or leaving the house invalidates pending work. A real Bank transfer before queued use/PIN resume preserves the banked item and stores nothing.
- Save/load uses existing PlayerSave persistent attributes. Stacked on #1417: both last and active item markers use the resolved NPC's physical form, including legacy migration. A plain text merge using the original base item here would lose the form on restart; the integration regression checks actual shutdown hooks and fresh login.

## Verification

New maintained real-object/native suites cover all eight item pairs, reachable forms, base collection progress, real Bank transfers, duplicate base copies, full inventory, repeated/foreign pickup, dead/trading refusal, alternate dust repeat, legacy Probita recovery and shutdown/save/login. Menagerie uses actual MaxHouse/PlayerHouseInstance, furniture, native item-on-object/View211/withdrawal, roaming NPCs, client form varbits, full inventory, PlayerSave/house re-entry and actual Bank PIN packets/deferred callbacks. Only network output is captured; game objects, containers, transfer, ownership and persistence are real.

Independent review reproduced an existing queued-use duplication through actual Bank.deposit, then verified the identity/state fix with unchanged failing assertions and normal controls. Its additional native PIN tests explicitly verify unlock before invalidating the delayed callback. Build/suite totals and final reviewed fingerprints are recorded in the PR.

Older base-only menagerie records still default to their stored base item; this change does not rewrite old house inventories or add POH form-selection controls. Other pet families, transcripts and exact field selection presentation remain separate work.

Final build passed; full frozen-source suite **9,216/9,216**, zero failures/skips. Authored forms/menagerie suites **29/29**; independent integration/native foundation checks **77/77**, UI delta **2/2**, and actual-cache WidgetManager with real server encoder/client decoder check passed. Full-suite Adventure Paths fixtures emit nonfailing Hunter/WarpedSceptre null-core hook errors; the reviewer reproduced them using unchanged origin/main modules. Critical Pets/reviewer/UI checks emitted none.

Actual rendering client: native dust Use, Olmlet→Puppadile→Tektiny→Enraged Tektiny and pickup; Flying form rendered after further native operations. Native menagerie View shows Flying Vespina icon/name24658; Take returns exactly one24658, Examine prints its actual description, Toggle changes server varbit2013 and removes/restores NPC9514, Close/reopen works. Native-input receipt and screenshots retained locally. Setup items and MaxHouse were seeded only in the isolated QA profile; no live installation.

Reviewed production SHA256: Pets `A4C51A692DF3CC631F825DC62E6BCAAC37937571303548E0D84A4E795D36ED06`; Dust `FCE999AD1D78D5B4AB3A52048AA5047DB83DCF588ACB70DC15991A6128B91F39`; Menagerie `DAB3776B3D314C9C47FE7C62C2703739AB76EE9A72DE5956008805265FFC10B7`. Reviewed HEAD before integration commit: `cc4afa10e93a0c15b6d7a17e9603167c007c44c7`; stacked prerequisite `d22baddd7cc01b80ee10ec2834385cbd2893fd59`.
