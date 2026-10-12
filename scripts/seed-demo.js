const url = process.env.APP_URL || "http://127.0.0.1:3000";
async function api(path, data) {
  const response = await fetch(
    `${url}${path}`,
    data
      ? {
          signal: AbortSignal.timeout(15000),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      : { signal: AbortSignal.timeout(15000) },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
try {
  const config = await api("/api/config");
  if (config.sms_mode !== "demo")
    throw new Error(
      "Demo data can only be created in SMS_MODE=demo. No changes made.",
    );
  const businesses = await api("/api/businesses");
  if (businesses.length)
    throw new Error(
      "This workspace already has businesses. Use an empty demo database to load sample data. No changes made.",
    );
  const harbor = await api("/api/businesses", {
    name: "Harbor Plumbing",
    phone: "+14165550101",
    booking_url: "https://example.com/harbor/book",
    google_review_url: "https://g.page/r/demo-harbor/review",
    sms_key: "HARBOR",
  });
  const path = `/api/businesses/${harbor.id}`;
  const names = [
    "Jamie Carter",
    "Alex Morgan",
    "Sam Wilson",
    "Taylor Bennett",
    "Jordan Lee",
    "Casey Brooks",
    "Morgan Park",
  ];
  const contacts = [];
  for (const [i, name] of names.entries())
    contacts.push(
      await api(`${path}/contacts`, {
        name,
        phone: `+1416555011${i}`,
        email: `${name.split(" ")[0].toLowerCase()}@example.com`,
        tags: [i === 6 ? "lead" : "customer"],
        notes: [
          "Kitchen tap replacement. Happy with the new finish.",
          "Annual water heater check.",
          "Fixed a slow drain in the upstairs bathroom.",
          "New kitchen sink installed.",
        ][i % 4],
        sms_consent: true,
      }),
    );
  const first = await api(`${path}/requests`, { contact_id: contacts[0].id });
  const second = await api(`${path}/requests`, { contact_id: contacts[1].id });
  await api(`${path}/requests/${first.id}/done`, {});
  await api(`${path}/demo/advance`, { days: 3 });
  await api(`${path}/requests`, { contact_id: contacts[2].id });
  const fourth = await api(`${path}/requests`, { contact_id: contacts[3].id });
  await api(`${path}/requests/${fourth.id}/done`, {});
  await api(`${path}/requests`, { contact_id: contacts[4].id });
  await api(`${path}/requests`, { contact_id: contacts[5].id });
  await api("/api/businesses", {
    name: "Summit Electric",
    phone: "+14165550201",
    booking_url: "https://example.com/summit/book",
    google_review_url: "https://g.page/r/demo-summit/review",
    sms_key: "SUMMIT",
  });
  console.log(
    "Demo workspace ready: 2 businesses, 7 customers and 6 simulated review requests. No real texts were sent.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
