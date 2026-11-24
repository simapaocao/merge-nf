import { z } from 'zod';
import { changesQuerySchema, createInstanceSchema, loginSchema, projectsQuerySchema, routes, sessionGroupsQuerySchema, sessionsQuerySchema, updateInstanceSchema } from '@nf-hub/protocol';
import { login, logout, sessionCookie, verifyCsrf, verifyOrigin, webSession } from './auth';
import { changes, instanceActivity, overview, projects, sessionGroups, sessions } from './dashboard';
import { fail, validated } from './errors';
import { noBody, queryParams, type Router, type Services } from './http-types';
import { createInstance, deleteInstance, instanceDto, instanceRecord, listInstances, updateInstance } from './instances';
import { readJson } from './limits';
import { issueCode, revoke } from './pairing';

export function webRoutes(app: Router, {db,config,clock,admission}: Services) {
  app.post(routes.login, async c => {
    verifyOrigin(config,c.req.raw);
    if (c.req.raw.headers.has('authorization')) fail(401,'UNAUTHENTICATED');
    admission.rate('logins',30,60_000); admission.rate(`login:${c.env.peerAddress}`,8,60_000);
    return admission.withSlot('login',2,async () => {
      const body = validated(loginSchema,await readJson(c.req.raw,8192));
      const result = await login(db,body.username,body.password,clock);
      c.header('Set-Cookie',sessionCookie(config,result.token)); return c.json(result.auth);
    });
  });
  app.use('/api/*', async (c,next) => {
    const s = webSession(db,config,c.req.raw,clock());
    if (!['GET','HEAD'].includes(c.req.method)) { verifyOrigin(config,c.req.raw); verifyCsrf(c.req.raw,s); }
    c.set('session',s); await next();
  });
  app.get(routes.me,c => { const {username,csrfToken} = c.get('session'); return c.json({username,csrfToken}); });
  app.post(routes.logout,c => { noBody(c); logout(db,c.get('session'),clock()); c.header('Set-Cookie',sessionCookie(config,'',true)); return c.body(null,204); });
  app.get(routes.instances,c => c.json(listInstances(db,clock())));
  app.get(`${routes.instances}/:id`,c => c.json(instanceDto(instanceRecord(db,validated(z.uuid(),c.req.param('id'))),clock())));
  app.post(routes.instances,async c => {
    const data = validated(createInstanceSchema,await readJson(c.req.raw)); webSession(db,config,c.req.raw,clock());
    return c.json(createInstance(db,config,data,clock()),201);
  });
  app.patch(`${routes.instances}/:id`,async c => {
    const id = validated(z.uuid(),c.req.param('id')), data = validated(updateInstanceSchema,await readJson(c.req.raw));
    webSession(db,config,c.req.raw,clock()); return c.json(updateInstance(db,config,id,data,clock()));
  });
  app.delete(`${routes.instances}/:id`,c => { noBody(c); deleteInstance(db,validated(z.uuid(),c.req.param('id')),clock()); return c.body(null,204); });
  app.post(`${routes.instances}/:id/pairing`,c => { noBody(c); return c.json(issueCode(db,validated(z.uuid(),c.req.param('id')),clock()),201); });
  app.post(`${routes.instances}/:id/revoke`,c => { noBody(c); return c.json(revoke(db,validated(z.uuid(),c.req.param('id')),clock())); });
  app.get(routes.overview,c => c.json(overview(db,clock())));
  app.get(routes.sessions,c => c.json(sessions(db,validated(sessionsQuerySchema,queryParams(c)),clock())));
  app.get(routes.instanceActivity,c => { validated(z.strictObject({}),queryParams(c)); return c.json(instanceActivity(db,clock())); });
  app.get(routes.sessionGroups,c => c.json(sessionGroups(db,validated(sessionGroupsQuerySchema,queryParams(c)),clock())));
  app.get(routes.projects,c => c.json(projects(db,validated(projectsQuerySchema,queryParams(c)))));
  app.get(routes.changes,c => {
    const {instances} = validated(changesQuerySchema,queryParams(c));
    const tags = c.req.header('If-None-Match')?.split(',').map(t => t.trim().replace(/^W\//,''));
    return db.transaction(() => {
      const now = clock(), result = changes(db,now), etag = `"${instances ? 'instances:' : ''}${result.version}"`;
      c.header('ETag',etag);
      if (tags?.includes(etag) || tags?.includes('*')) return c.body(null,304);
      return c.json(instances ? {...result,instances:listInstances(db,now).items} : result);
    })();
  });
}
