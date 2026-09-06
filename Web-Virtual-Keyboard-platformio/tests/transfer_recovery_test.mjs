import assert from "node:assert/strict";
import vm from "node:vm";
import { context, getElement } from "./index_script_test.mjs";

const run = code => vm.runInContext(code, context);
const response = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
// Keep request deadlines real; shorten only polling/backoff in these tests.
context.setTimeout = (fn, ms) => setTimeout(fn, ms === 10000 ? ms : 0);
const createJob = () => run('makeTransfer(utf8Bytes("abc"), "test.txt", "raw")');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// First start is accepted but its response is lost. A repeated ID recovers
// the existing session, so only one header/session may be created.
let session, starts = 0, startRequests = 0, chunks = 0;
context.fetch = async (path, options) => {
  const form = new URLSearchParams(options?.body);
  if (path === "/transfer/start") {
    startRequests++;
    if (!session) {
      session = { id: form.get("id"), state: "ready", next: 0 };
      starts++;
      throw new Error("accepted, response lost");
    }
    assert.equal(form.get("id"), session.id);
    return response(session);
  }
  if (path === "/transfer/chunk") { chunks++; session = { ...session, state: "complete", next: 1 }; return response(session); }
  if (path === "/transfer/status") { return response(session); }
  throw new Error(path);
};
context.job = createJob();
await run("runTransfer(job)");
assert.equal(starts, 1);
assert.equal(startRequests, 2);
assert.equal(chunks, 1);
assert.equal(run("activeTransfer"), null);

// All start responses lost: retain the exact ID and expose both recovery and
// cancellation. Do not allow a new job to overwrite the recoverable one.
let retainedId;
context.fetch = async (path, options) => {
  assert.equal(path, "/transfer/start");
  const id = new URLSearchParams(options.body).get("id");
  if (retainedId) { assert.equal(id, retainedId); }
  retainedId = id;
  throw new Error("response lost");
};
context.job = createJob();
await run("runTransfer(job)");
assert.equal(run("activeTransfer.id"), retainedId);
assert.equal(getElement("resumeTransfer").hidden, false);
assert.equal(getElement("stopTransfer").hidden, false);
assert.equal(getElement("startTransfer").disabled, true);
// Resume repeats the start with the same ID, including if it already completed.
context.fetch = async (path, options) => {
  if (path === "/transfer/start") { assert.equal(new URLSearchParams(options.body).get("id"), retainedId); }
  else { assert.equal(path, "/transfer/status"); }
  return response({ id: retainedId, state: "complete", next: 1 });
};
await run("resumeActiveTransfer()");
assert.equal(run("activeTransfer"), null);

// Cancel before the original start response returns. The client already knows
// its ID, so cancellation can be sent without waiting for that response.
const startEntered = deferred(), startResponse = deferred();
let cancelId;
context.job = createJob();
context.fetch = async (path, options) => {
  if (path === "/transfer/start") { startEntered.resolve(); return startResponse.promise; }
  assert.equal(path, "/transfer/cancel");
  cancelId = new URLSearchParams(options.body).get("id");
  return response({ id: cancelId, state: "cancelled" });
};
const running = run("runTransfer(job)");
await startEntered.promise;
await run("stopActiveTransfer()");
assert.equal(cancelId, context.job.id);
startResponse.resolve(response({ id: cancelId, state: "ready", next: 0 }));
await running;
assert.equal(run("activeTransfer"), null);
assert.equal(context.job.cancelConfirmed, true);

// Failed cancel retains the session and stop button; no success message, no
// resume, and a second click retries cancellation after connectivity returns.
const statusEntered = deferred(), statusResponse = deferred();
context.job = createJob();
let cancelAttempts = 0;
context.fetch = async path => {
  if (path === "/transfer/start") { return response({ id: context.job.id, state: "ready", next: 0 }); }
  if (path === "/transfer/status") { statusEntered.resolve(); return statusResponse.promise; }
  assert.equal(path, "/transfer/cancel");
  if (++cancelAttempts === 1) { throw new Error("offline"); }
  return response({ id: context.job.id, state: "cancelled" });
};
const running2 = run("runTransfer(job)");
await statusEntered.promise;
await run("stopActiveTransfer()");
statusResponse.resolve(response({ id: context.job.id, state: "typing", next: 0 }));
await running2;
assert.equal(run("activeTransfer"), context.job);
assert.equal(context.job.cancelConfirmed, false);
assert.equal(getElement("stopTransfer").hidden, false);
assert.equal(getElement("stopTransfer").disabled, false);
assert.equal(getElement("resumeTransfer").hidden, true);
assert.match(run("toast.textContent"), /중지를 확인하지 못했습니다/);
await run("stopActiveTransfer()");
assert.equal(cancelAttempts, 2);
assert.equal(run("activeTransfer"), null);

// A USB failure is terminal: no next chunk, no false completion, no resume.
context.job = createJob();
context.fetch = async path => {
  if (path === "/transfer/start") { return response({ id: context.job.id, state: "typing", next: 0 }); }
  assert.equal(path, "/transfer/status");
  return response({ id: context.job.id, state: "error", next: 0, error: "USB transfer failed" });
};
await run("runTransfer(job)");
assert.equal(context.job.next, 0);
assert.equal(getElement("resumeTransfer").hidden, true);
assert.equal(getElement("stopTransfer").hidden, false);
assert.match(getElement("progressLabel").textContent, /USB transfer failed/);
assert.equal(run('sameTransfer(job, {id:"", state:"idle"})'), false);

// Reject Unicode in the preset dialog before any HTTP request can be sent.
context.fetch = async () => { throw new Error("must not save a Unicode preset"); };
run('editing = null; mName.value = "한글 테스트"; mValue.value = "한"; mGroup.value = "";');
await run("saveModal()");
assert.match(run("valueErr.textContent"), /US-ASCII/);
// A request that never answers must time out so recovery controls can return.
context.setTimeout = (fn, ms) => setTimeout(fn, ms === 10000 ? 5 : ms);
context.fetch = async (_path, options) => new Promise((_resolve, reject) => {
  options.signal.addEventListener("abort", () => reject(new Error("deadline exceeded")));
});
await assert.rejects(run('fetchWithTimeout("/transfer/status")'), /deadline exceeded/);
console.log("transfer recovery tests passed");
