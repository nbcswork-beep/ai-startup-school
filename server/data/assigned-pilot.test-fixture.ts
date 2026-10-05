import {MemoryRepository} from './memory-repository.js';
import {createPilotRuntimeState,MemoryPilotRuntimeStore} from './pilot-runtime-store.js';

// Existing domain tests deliberately start with assigned lessons and published work.
// Runtime initialization itself now has no assignments; that default is tested separately.
export function createAssignedPilotState(){return createPilotRuntimeState({includeDemoContent:true});}
export function createAssignedRepository(users?:ConstructorParameters<typeof MemoryRepository>[0],options?:ConstructorParameters<typeof MemoryRepository>[1]){
  return new MemoryRepository(users,{runtimeStore:new MemoryPilotRuntimeStore(createAssignedPilotState()),...options});
}
