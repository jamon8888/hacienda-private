import { test, expect, request } from "@playwright/test";

test("delete matter removes it from server", async () => {
  const api = await request.newContext();
  const list = await api.get("/matters");
  const { matters } = await list.json();
  const target = matters.find((m: { name: string }) => m.name.startsWith("matter-"));
  expect(target).toBeTruthy();
  const del = await api.delete(`/matters/${target.id}`, { headers: { authorization: "Bearer admin" } });
  expect(del.status()).toBe(200);
  const after = await (await api.get("/matters")).json();
  expect(after.matters.find((m: { id: string }) => m.id === target.id)).toBeUndefined();
});
