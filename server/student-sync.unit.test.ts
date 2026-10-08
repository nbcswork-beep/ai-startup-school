import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('academic refresh while a Student request is pending', () => {
  it('defers a changed revision and applies it on the next check after the request finishes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', class { addEventListener() {} });
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
    const { startAcademicSync } = await import('../src/academic-sync.js');
    let finish: (value: { revision: string }) => void;
    const outstanding = new Promise<{ revision: string }>(resolve => { finish = resolve; });
    const revision = vi.fn().mockReturnValueOnce(outstanding).mockResolvedValue({ revision: 'changed' });
    const refresh = vi.fn().mockResolvedValue(undefined);
    let canApply = true;
    startAcademicSync({ revision, refresh, canApply: () => canApply });
    canApply = false;
    finish!({ revision: 'changed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
    canApply = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('retries the same revision if a refresh was deferred during its request', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', class { addEventListener() {} });
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
    const { startAcademicSync } = await import('../src/academic-sync.js');
    const revision = vi.fn().mockResolvedValue({ revision: 'changed' });
    const refresh = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    startAcademicSync({ revision, refresh });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
