const { API_URL } = require("./config");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`${API_URL}?${qs}`);
  return res.json();
}

async function post(payload, { rate = 400 } = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "text/plain" },
  });
  await sleep(rate);
  return res.json();
}

// Builds a name-keyed map of person_id from the live sheet so seed scripts
// never depend on a stale person_ids.json.
async function fetchPersonIds() {
  const data = await get("getAll");
  const byName = {};
  (data.persons || []).forEach((p) => {
    byName[`${p.gikuyu_name} ${p.fathers_name}`] = p.person_id;
  });
  return byName;
}

module.exports = { API_URL, get, post, sleep, fetchPersonIds };