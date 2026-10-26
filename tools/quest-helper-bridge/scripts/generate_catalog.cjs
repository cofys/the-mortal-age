const fs=require('node:fs'),path=require('node:path');
// Run from the repository: node tools/quest-helper-bridge/scripts/generate_catalog.cjs
const root=path.resolve(__dirname,'../../..');
const upstream=process.env.QUEST_HELPER_SOURCE||path.join(__dirname,'..','quest-helper-upstream');
const text=fs.readFileSync(path.join(root,'server/plugins/quests/Quests.plugin.js'),'utf8');
const keys=[...text.split('const QUESTS = [')[1].split(']')[0].matchAll(/"([A-Za-z0-9]+)"/g)].map(x=>x[1]);
const src=fs.readFileSync(path.join(upstream,'src/main/java/com/questhelper/questinfo/QuestHelperQuest.java'),'utf8');
const imports=Object.fromEntries([...src.matchAll(/import (com\.questhelper\.helpers\.[\w.]+);/g)].map(x=>[x[1].split('.').at(-1),x[1]]));
const sourceRoot=path.join(upstream,'src/main/java');
for(const rel of fs.readdirSync(sourceRoot,{recursive:true}))if(rel.endsWith('.java')){const full=rel.replaceAll(path.sep,'.').replaceAll('/','.').slice(0,-5);const name=full.split('.').at(-1);if(!imports[name])imports[name]=full;}
const routes=[...src.matchAll(/^\s*([A-Z][A-Z_0-9]+)\(new (\w+)\(/gm)].map(x=>({helperVariant:x[1],helperClass:imports[x[2]]||x[2]}));
function norm(x){return x.toLowerCase().replace(/[^a-z0-9]/g,'').replace(/^the/,'').replace(/^a/,'');}
const aliases={BlackKnightsFortress:'BlackKnightFortress',FairytaleIGrowingPains:'FairytaleI',FairytaleIICureAQueen:'FairytaleII',PerilousMoons:'PerilousMoon',TwilightPromise:'TwilightsPromise',DesertTreasureI:'DesertTreasure',RibbitingTale:'TheRibbitingTaleOfALilyPadLabourDispute'};
const catalog=keys.map(questKey=>{let variants=routes.filter(r=>norm(r.helperClass.split('.').at(-1))===norm(aliases[questKey]||questKey));if(questKey==='RecipeForDisaster')variants=routes.filter(r=>r.helperVariant.startsWith('RECIPE_FOR_DISASTER_'));if(questKey==='ShieldOfArrav')variants=routes.filter(r=>r.helperVariant.startsWith('SHIELD_OF_ARRAV_'));const file=fs.readFileSync(path.join(root,'server/plugins/quests/quests',questKey+'.Quest.js'),'utf8');const canonical=file.match(/registerQuest\(api,\s*\{[\s\S]*?\bkey:\s*["']([^"']+)["']/);const explicit={RecipeForDisaster:'recipe_for_disaster',RibbitingTale:'the_ribbiting_tale_of_a_lily_pad_labour_dispute',TheHeartOfDarkness:'the_heart_of_darkness'};if(!canonical&&!explicit[questKey])throw Error('NO_CANONICAL '+questKey);return{questKey:canonical?.[1]||explicit[questKey],sourceKey:questKey,variants,native:questKey==='LearningTheRopes'};});
for(const c of catalog)if(!c.native&&!c.variants.length)console.log('UNMAPPED',c.questKey);
fs.writeFileSync(path.join(__dirname,'..','src/main/resources/catalog.json'),JSON.stringify(catalog,null,2)+'\n');console.log(catalog.length,'keys',catalog.filter(c=>c.native||c.variants.length).length,'mapped');


