import {it,expect} from 'vitest';
import {visibleSessions} from '../../src/session-visibility.js';
it('uses the same active and history status selection for Teacher/Admin and group pages',()=>{
 const sessions=['scheduled','rescheduled','in_progress','completed','cancelled','archived'].map(status=>({id:status,status,startsAt:'2027-01-01T10:00:00Z'}));
 expect(visibleSessions(sessions).map(s=>s.id)).toEqual(['scheduled','rescheduled','in_progress']);
 expect(visibleSessions(sessions,'cancelled').map(s=>s.id)).toEqual(['cancelled']);expect(visibleSessions(sessions,'archived').map(s=>s.id)).toEqual(['archived']);
 expect(visibleSessions(sessions,'completed').map(s=>s.id)).toEqual(['completed']);expect(visibleSessions(sessions,'all')).toEqual(sessions);
});
