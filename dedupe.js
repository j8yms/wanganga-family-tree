const API_URL = "https://script.google.com/macros/s/AKfycbxxgjND3ex5xTp3eUV8uCX6XAwtWax4EZ2tHpeOcVx80tZMx7IMXLyWFzZ7qfRBK0gEqA/exec";

async function get(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`${API_URL}?${qs}`);
  return res.json();
}

async function post(payload) {
  const res = await fetch(API_URL, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "text/plain" },
  });
  return res.json();
}

async function main() {
  const data = await get("getAll");
  const rels = data.relationships;
  const seen = {};
  let removed = 0;

  for (const r of rels) {
    const key = `${r.parent_id}|${r.child_id}|${r.rel_type}`;
    if (seen[key]) {
      const res = await post({ action: "deleteRelationship", relationship_id: r.relationship_id });
      console.log(`Removed duplicate: ${key} => ${res.success}`);
      removed++;
      await new Promise((r2) => setTimeout(r2, 400));
    } else {
      seen[key] = true;
    }
  }

  const after = await get("getAll");
  console.log(`\nTotal relationships now: ${after.relationships.length}`);
}

main();