import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { readTerminalValue } from '../scripts/secure-prompt.mjs';

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  setRawMode(value:boolean){this.isRaw=value;return this}
  isPaused(){return this.paused}
  resume(){this.paused=false;return this}
  pause(){this.paused=true;return this}
}

class FakeOutput {
  isTTY = true;
  chunks:string[]=[];
  write(value:string){this.chunks.push(value);return true}
  get text(){return this.chunks.join('')}
}

describe('secure terminal prompt',()=>{
  it('accepts Ctrl+V clipboard input without displaying a hidden secret',async()=>{
    const input=new FakeInput(),output=new FakeOutput();
    const clipboardReader=vi.fn(()=>'123456789:test_bot_token');
    const result=readTerminalValue('Secret: ',{hidden:true,input,output,clipboardReader});
    input.emit('keypress','\u0016',{ctrl:true,shift:false,name:'v'});
    input.emit('keypress','\r',{name:'return'});
    await expect(result).resolves.toBe('123456789:test_bot_token');
    expect(clipboardReader).toHaveBeenCalledOnce();
    expect(output.text).toBe('Secret: \n');
    expect(input.isRaw).toBe(false);
    expect(input.paused).toBe(true);
  });

  it('accepts terminal-managed paste, Backspace, and Ctrl+Shift+V',async()=>{
    const input=new FakeInput(),output=new FakeOutput();
    const clipboardReader=vi.fn(()=>'restored');
    const result=readTerminalValue('Secret: ',{hidden:true,input,output,clipboardReader});
    input.emit('keypress','direct-paste-X',{});
    input.emit('keypress','\b',{name:'backspace'});
    input.emit('keypress','\u0016',{ctrl:true,shift:true,name:'v'});
    input.emit('keypress','\r',{name:'enter'});
    await expect(result).resolves.toBe('direct-paste-restored');
    expect(output.text).not.toContain('direct-paste');
    expect(output.text).not.toContain('restored');
  });

  it('cancels cleanly on Ctrl+C without revealing accumulated input',async()=>{
    const input=new FakeInput(),output=new FakeOutput();
    const result=readTerminalValue('Secret: ',{hidden:true,input,output,clipboardReader:()=>''});
    input.emit('keypress','hidden-value',{});
    input.emit('keypress','\u0003',{ctrl:true,name:'c'});
    await expect(result).rejects.toThrow('Cancelled');
    expect(output.text).toBe('Secret: \n');
    expect(input.isRaw).toBe(false);
    expect(input.paused).toBe(true);
  });
});
