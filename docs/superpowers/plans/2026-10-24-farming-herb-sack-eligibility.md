# Herb sack eligibility

The OSRS Wiki Herb sack page restricts storage to normal grimy herbs and excludes clean/noted herbs and coral. Goutweed is an herb-patch crop but not a normal grimy herb; the shared storeCrop helper currently accepts it.

1. Reproduce direct storage, Fill and item-pair handling accepting goutweed. Verify all 15 normal grimy herbs, including huasca, plus existing exclusions and capacities.
2. Restrict herb-sack candidates to Farming's canonical herb products with cache names identifying them as grimy herbs. Avoid a one-off goutweed exception; keep seed-box handling unchanged.
3. Build, run focused/model checks and the full server suite, obtain independent review and publish a separate PR from upstream main.

Source: https://oldschool.runescape.wiki/w/Herb_sack . The newer silklined sack, ground pickup and native interfaces are separate work.
