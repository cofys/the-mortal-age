# Disease checks during Kronos growth skips

The OSRS Wiki Kronos plant page says every growth stage, including skipped stages, checks for disease and pauses where disease occurs. The shared model currently jumps to the last stage and checks disease only there, or skips disease entirely on reaching maturity.

1. Reproduce early/later skipped-stage disease, skips reaching maturity, shared skips with independent patch disease, protected growth, offline/save equivalence and anima exclusion. Five regression groups fail against the original model.
2. Advance the selected number of stages one at a time, stopping at disease, maturity or anima death. Preserve the shared skip-count cache and its explicitly estimated probability; no new probability claim.
3. Run the new regressions, existing Farming model checks, TypeScript build and complete server suite, then independent review and a separate upstream-main PR.

Source: https://oldschool.runescape.wiki/w/Kronos_plant . Regrowth acceleration and unpublished probabilities are outside this fix.
