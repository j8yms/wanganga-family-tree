const { get, post, sleep } = require("./api");

async function main() {
  const data = await get("getAll");
  const rels = data.relationships || [];
  const seen = {};
  let removed = 0;

  for (const r of rels) {
    const key = `${r.parent_id}|${r.child_id}|${r.rel_type}`;
    if (seen[key]) {
      const res = await post({ action: "deleteRelationship", relationship_id: r.relationship_id });
      console.log(`Removed duplicate: ${key} => ${res.success}`);
      removed++;
      await sleep(400);
    } else {
      seen[key] = true;
    }
  }

  const after = await get("getAll");
  console.log(`\nTotal relationships now: ${after.relationships.length}`);
}

main();