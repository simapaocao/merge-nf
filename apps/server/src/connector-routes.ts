import { LIMITS, failedRequestSchema, routes, runRequestSchema } from '@nf-hub/protocol';
import { fail, validated } from './errors';
import type { Router, Services } from './http-types';
import { readJson } from './limits';
import { bearerHash, claim, credential } from './pairing';
import { acceptSnapshot, failRun, startRun } from './sync';

function runNumber(text: string) {
  const n = Number(text); if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(n)) fail(400,'INVALID_INPUT'); return n;
}
export function connectorRoutes(app: Router, {db,clock,admission}: Services) {
  app.post(routes.pair,async c => {
    const req = c.req.raw;
    if (req.headers.has('cookie') || req.headers.has('authorization') || req.headers.has('origin')) fail(403,'FORBIDDEN');
    admission.rate('pairAttempts',60,60_000); admission.rate(`pair:${c.env.peerAddress}`,20,60_000);
    return admission.withSlot('pair',2,async () => c.json(claim(db,await readJson(req,LIMITS.snapshotBytes),clock()),201));
  });
  app.use('/api/connector/*', async (c,next) => {
    admission.rate('connectorRequests',2400,60_000);
    const hash = bearerHash(c.req.raw), actor = credential(db,hash);
    admission.rate(`requests:${actor.id}`,90,60_000);
    c.set('tokenHash',hash); c.set('instanceId',actor.id); await next();
  });
  app.post(routes.runs, async c => {
    admission.rate(`runs:${c.get('instanceId')}`,12,60_000);
    return c.json(startRun(db,c.get('tokenHash'),validated(runRequestSchema,await readJson(c.req.raw,1024)),clock()),201);
  });
  app.post(`${routes.runs}/:id/snapshot`, async c => {
    const id = runNumber(c.req.param('id'));
    admission.rate(`packets:${c.get('instanceId')}`,16,60_000);
    return admission.withSlot('snapshot',2,async () => c.json(await acceptSnapshot(db,c.get('tokenHash'),id,await readJson(c.req.raw,LIMITS.snapshotBytes),clock)));
  });
  app.post(`${routes.runs}/:id/failed`, async c => {
    const id = runNumber(c.req.param('id')), data = validated(failedRequestSchema,await readJson(c.req.raw,2048));
    failRun(db,c.get('tokenHash'),id,data,clock()); return c.body(null,204);
  });
  // Never pass a connector route into browser authentication, even for an unknown endpoint.
  app.all('/api/connector/*',() => fail(404,'NOT_FOUND'));
}
