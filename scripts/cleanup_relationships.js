// One-off data-repair tool for the Relationships sheet.
//
// Fixes the two classes of breakage that make live people vanish from the tree:
//   1. DANGLING ROWS - relationships whose parent_id / child_id no longer exist
//      in the Persons sheet (orphaned rows left behind when seed people were
//      merged/replaced). They can never render.
//   2. HOUSEHOLD CORRUPTION - duplicate spouse rows recorded in both directions
//      plus reversed "wife-as-father" rows. The renderer treats the child_id
//      side of a Spouse row as the secondary spouse, so a husband who gets
//      flagged this way is excluded from his own father's branch and drags his
//      whole household off the tree.
//   3. EXACT DUPLICATES - identical (parent_id, child_id, rel_type) rows.
//
// Usage:
//   node scripts/cleanup_relationships.js            # dry-run (default)
//   node scripts/cleanup_relationships.js --apply    # delete for real
//
// You will be prompted for the site ADMIN CODE (the one used to unlock the
// Research tab). It is sent as admin_token on every delete.

const readline = require("readline");
const { get, post } = require("./api");

const FAMILY_HEADING_RE = /father|mother|spouse/i;

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      char = String(char);
      if (char === "\u0003") { process.exit(); }
      process.stdout.write("\x1b[2K\x1b[200D" + question + "*".repeat(ask.length));
    };
    let ask = "";
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      resolve(answer.trim());
    });
    rl._writeToOutput = function () { rl.output.write(""); };
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  const data = await get("getAll");
  const persons = data.persons || [];
  const rels = data.relationships || [];

  const livePersonIds = new Set(persons.map((p) => String(p.person_id)));
  const nameOf = (id) => {
    const p = persons.find((x) => String(x.person_id) === String(id));
    return p ? `${p.gikuyu_name} ${p.fathers_name}`.trim() : `[MISSING ${id}]`;
  };

  // ------------------------------------------------------------------ rules
  const toDelete = [];      // { relationship_id, why }
  const dangling = [];
  rels.forEach((r) => {
    if (!r.rel_type || !FAMILY_HEADING_RE.test(r.rel_type)) return;
    const pMissing = !livePersonIds.has(String(r.parent_id));
    const cMissing = !livePersonIds.has(String(r.child_id));
    if (pMissing || cMissing) {
      dangling.push(r.relationship_id);
      toDelete.push({ relationship_id: r.relationship_id, why: `dangling (${pMissing ? "parent " : ""}${cMissing ? "child " : ""}missing): ${nameOf(r.parent_id)} -> ${nameOf(r.child_id)} [${r.rel_type}]` });
    }
  });

  // Reversed / duplicate spouse rows for the same couple.
  const couples = {};
  rels.forEach((r) => {
    if (!r.rel_type || String(r.rel_type).toLowerCase() !== "spouse") return;
    const a = String(r.parent_id), b = String(r.child_id);
    if (!livePersonIds.has(a) || !livePersonIds.has(b)) return;
    const key = [a, b].sort().join("|");
    (couples[key] = couples[key] || []).push(r);
  });
  Object.values(couples).forEach((rows) => {
    if (rows.length < 2) return;
    // Prefer the orientation parent=Male -> child=Female (the app writes a
    // husband as the parent side of a spouse row). For the wawerũ/Wagio mess
    // this keeps husband-as-parent instead of the reversed wife rows that
    // wrongly flag the husband as a secondary spouse.
    let keep = rows[0];
    for (const r of rows) {
      const parentIsMale = persons.find((p) => String(p.person_id) === String(r.parent_id) && (p.gender === "Male" || p.gender === "M"));
      if (parentIsMale) { keep = r; break; }
    }
    rows.forEach((r) => {
      if (r.relationship_id !== keep.relationship_id) {
        toDelete.push({ relationship_id: r.relationship_id, why: `duplicate spouse orientation: ${nameOf(r.parent_id)} <-> ${nameOf(r.child_id)} (keeping parent-side ${nameOf(keep.parent_id)})` });
      }
    });
  });

  // "Wife/partner listed as own partner's parent" - a father/mother row where
  // the parent and the child are a couple. Spouses never parent each other, so
  // these reversed rows must go (e.g. Wagio listed as wawerũ's father).
  const couplePair = {};
  rels.forEach((r) => {
    if (r.rel_type && String(r.rel_type).toLowerCase() === "spouse") {
      couplePair[`${r.parent_id}|${r.child_id}`] = true;
      couplePair[`${r.child_id}|${r.parent_id}`] = true;
    }
  });
  rels.forEach((r) => {
    if (!/father|mother/i.test(r.rel_type || "")) return;
    if (couplePair[`${r.parent_id}|${r.child_id}`]) {
      toDelete.push({ relationship_id: r.relationship_id, why: `spouse listed as parent of their own partner: ${nameOf(r.parent_id)} -> ${nameOf(r.child_id)} [${r.rel_type}]` });
    }
  });

  // Exact duplicates.
  const byTriple = {};
  rels.forEach((r) => {
    if (!r.rel_type || !FAMILY_HEADING_RE.test(r.rel_type)) return;
    const key = `${r.parent_id}|${r.child_id}|${r.rel_type}`;
    (byTriple[key] = byTriple[key] || []).push(r);
  });
  Object.values(byTriple).forEach((rows) => {
    if (rows.length < 2) return;
    const keepRow = rows[0];
    rows.slice(1).forEach((r) => {
      if (!toDelete.some((d) => d.relationship_id === r.relationship_id)) {
        toDelete.push({ relationship_id: r.relationship_id, why: `exact duplicate of ${keepRow.relationship_id}: ${nameOf(r.parent_id)} -> ${nameOf(r.child_id)} [${r.rel_type}]` });
      }
    });
  });

  // ------------------------------------------------------------------ report
  console.log(`Live data: ${persons.length} people, ${rels.length} relationships`);
  console.log(`Identified ${toDelete.length} rows to delete (${dangling.length} dangling, rest corruption):\n`);
  toDelete.forEach((d) => console.log(`  - [${d.relationship_id}] ${d.why}`));

  if (toDelete.length === 0) {
    console.log("\nNothing to clean up.");
    return;
  }

  if (!apply) {
    console.log("\nDry-run: nothing deleted. Re-run with --apply to delete for real.");
    return;
  }

  const adminCode = await promptHidden("Site admin code: ");
  if (!adminCode) {
    console.log("\nNo admin code given - aborting.");
    return;
  }

  let ok = 0, failed = 0;
  for (const d of toDelete) {
    try {
      const res = await post({ action: "deleteRelationship", relationship_id: d.relationship_id, admin_token: adminCode });
      if (res && res.success) { ok++; console.log(`  deleted ${d.relationship_id}`); }
      else { failed++; console.log(`  FAILED ${d.relationship_id}: ${(res && res.error) || "unknown"}`); }
    } catch (err) {
      failed++; console.log(`  ERROR ${d.relationship_id}: ${err.message}`);
    }
  }
  console.log(`\nDone: ${ok} deleted, ${failed} failed.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });