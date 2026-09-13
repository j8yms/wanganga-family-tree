const { get, post, fetchPersonIds } = require("./api");

const spousePairs = [
  { primary: "Mwangi Kiama", ghost: "Wanjiku Mwangi" },
  { primary: "Njoroge Mwangi", ghost: "Wambui Njoroge" },
  { primary: "Kamau Njoroge", ghost: "Njeri Kamau" },
  { primary: "Thiong'o Kamau", ghost: "Wanjiku Thiong'o" },
  { primary: "Maina Thiong'o", ghost: "Wairimu Maina" },
];

async function main() {
  const data = await get("getAll");
  const byName = await fetchPersonIds();
  const existingRels = data.relationships || [];

  let created = 0, skipped = 0;
  for (const pair of spousePairs) {
    const pid = byName[pair.primary];
    const sid = byName[pair.ghost];
    if (!pid || !sid) { console.log(`MISSING ids for ${pair.primary} / ${pair.ghost}`); continue; }

    const exists = existingRels.some(r =>
      (String(r.parent_id) === String(pid) && String(r.child_id) === String(sid)) ||
      (String(r.parent_id) === String(sid) && String(r.child_id) === String(pid))
    );
    if (exists) { console.log(`Already linked: ${pair.primary} <-> ${pair.ghost}`); skipped++; continue; }

    const res = await post({
      action: "createRelationship",
      parent_id: pid,
      child_id: sid,
      rel_type: "Spouse",
    });
    if (res.success) { created++; console.log(`Spouse link: ${pair.primary} <-> ${pair.ghost}`); }
    else console.log(`FAILED ${pair.primary}: ${res.error}`);
  }

  console.log(`\n${created} new spouse links, ${skipped} already existed`);
}

main();