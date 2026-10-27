# Native Adventure Paths journal integration

Parent: PR #1356. Own slot83, branch feat/adventure-paths-journal.

## Cache evidence

Side journal629:26 (adventurepath_list) has Show and Disable Adventure Paths
operations. Its focus panel is644. Journal selection is varbit8168
(side_journal_tab); content mounts at629:43 (tab_container). The exported client
tab3 mapping187 points at generic menu, not this panel, but that map is currently
unused at runtime. No client mapping change is required.

## Design

- Add Journal.AdventurePaths.js with named handlers, called by the existing plugin.
  Header Show mounts644 at629:43, type1, or defers while an AP modal owns it; Disable uses the shared native chat prompt
  and requires confirmation. Ineligible accounts cannot operate either control.
- The existing PacketSender relocates a group when mounted on a different parent,
  avoiding duplicate644 panels. Main overview/reward routes keep the parent's
  sidemodal placement. After those modals close, restore644 in the journal when
  the player still prefers that tab.
- Persist an AP journal preference. First enrollment defaults it on. Respect the shared mount notification (even when a prior handler consumed a click) and native side-journal varp changes and do not steal later user
  selections. Schedule a single guarded UI restore after login/all default hooks;
  no polling, no skilling task. Pending restores expire on logout/state replacement.
- Canonical Jon opt-out/opt-in calls the same participation setter as the header.
  Disabling removes only owned AP panels and uses the existing journal's summary
  mounting/row flags. It must preserve unrelated main interfaces and other tabs.
- Add a small generic side-journal:mount custom event to SideJournalDefaults,
  forwarding validated backend group/tab requests to its existing mount function, which emits a side-journal:mounted notification.
  No feature logic in core, no Leagues tab4 changes and no edits in Claude's tree.

## Validation

Native629:26 Show/Disable clicks and real219 confirmations; opt-in via Jon; panel
relocation main/journal/close; saved preference with other-tab selection, login and
logout; delayed restore after a replacement modal; ineligible/dead/trading states;
main view and summary row flags. Existing27 tests remain in the stacked suite.
Build, full server suite, client VM, own MCP walkthrough, independent Codex review
before separate stacked PR; stop owned helpers and servers.

## Recording limitation

No indexed AP/Jon interaction captures. Cache IDs/options/layout are authoritative;
post-login restore ordering and use of the shared native confirmation prompt are
implementation choices and will be disclosed.

## Independent design review applied

Header Show must not steal644 from an open AP modal. Any newer tab mount cancels
an older restore; tracking uses a shared mount notification plus native journal
varp changes, not handler order. Restore checks the same player/state, active
participation, saved preference and absence of any replacement main modal. A
main/chatbox close can schedule a later retry; there is no polling.

## Implementation review corrections

Disable confirmation requires no open main modal, including the AP viewer, because
the shared confirmation service closes modal interfaces before either response.
The selected AP tab, not just the presence of644, controls summary restoration
after opt-out: a previous modal may already have removed the side panel. An
actual different tab selection remains intact. Native regressions reproduce both
review findings and also cover preserving another selected journal tab.
