export function isRetryableUploadError(error) {
  return error?.retryable === true || /timed out|timeout|closed|connection|runtime|network|peer|соединен|подключен|передач|ожидаю/i.test(String(error?.message ?? ''));
}

/** Page-lifetime queue: originals and immutable publication records survive reconnects. */
export function createImageUploadQueue({ isReady = () => true, onChange = () => {}, retryDelayMs = 1000 } = {}) {
  const jobs = [];
  const idleWaiters = [];
  const settleIdle = () => { if (!running && !jobs.some(job => ['queued','waiting','uploading'].includes(job.status))) while(idleWaiters.length) idleWaiters.shift()(); };
  let running = false, closed = false, retryTimer = null;
  const snapshot = () => jobs.map(({id,name,status,error,attempts}) => ({id,name,status,error,attempts}));
  const notify = () => { if (!closed) onChange(snapshot()); };
  const schedule = () => { if (!closed && !running && retryTimer == null) queueMicrotask(drain); };
  async function drain() {
    if (closed || running || retryTimer != null) return;
    running = true;
    try {
      for (;;) {
        const job = jobs.find(item => item.status === 'queued' || item.status === 'waiting');
        if (!job || closed) break;
        if (!isReady()) { job.status = 'waiting'; job.error = 'Ожидаю восстановления соединения'; notify(); break; }
        job.status = 'uploading'; job.error = ''; job.attempts += 1; notify();
        try {
          await job.process(job, () => !closed);
          if (closed) break;
          job.status = 'done'; job.error = '';
          // Do not retain decoded images and original files after acknowledgement.
          job.file = null; job.records = null; job.object = null; job.process = null;
        } catch (error) {
          if (closed) break;
          job.error = String(error?.message || 'Не удалось загрузить файл');
          if (!isReady()) {
            job.status = 'waiting'; job.attempts = Math.max(0, job.attempts - 1); notify(); break;
          }
          if (isRetryableUploadError(error) && job.attempts < 3) {
            job.status = 'waiting'; notify();
            const delay = Math.max(0, Number(retryDelayMs) || 0) * job.attempts;
            if (delay) retryTimer = setTimeout(() => { retryTimer = null; schedule(); }, delay);
            else queueMicrotask(schedule);
            break;
          }
          job.status = 'failed'; // Keep this file and its exact action identity for Retry.
        }
        notify();
      }
    } finally { running = false; settleIdle(); }
  }
  return {
    add(items, process) {
      if (closed) return [];
      if (typeof process !== 'function') throw new TypeError('Upload processor is required');
      const ids = new Set(jobs.map(job => job.id));
      for (const item of items) {
        if (!item?.id || ids.has(item.id)) throw new Error('Upload job requires a unique id');
        ids.add(item.id);
        jobs.push({...item, process, status:'queued', error:'', attempts:0});
      }
      notify(); schedule(); return items.map(item => item.id);
    },
    resume() { if (closed) return; clearTimeout(retryTimer); retryTimer = null; schedule(); },
    retry(id) {
      if (closed) return;
      const job = jobs.find(item => item.id === id);
      if (!job || !['failed','waiting'].includes(job.status)) return;
      job.status = 'queued'; job.error = ''; job.attempts = 0; notify(); schedule();
    },
    dismissDone() { for (let i=jobs.length-1;i>=0;i--) if(jobs[i].status==='done') jobs.splice(i,1); notify(); },
    whenIdle() { if (closed || !running && !jobs.some(job => ['queued','waiting','uploading'].includes(job.status))) return Promise.resolve(); return new Promise(resolve => idleWaiters.push(resolve)); },
    pause() { if (closed) return; for (const job of jobs) if (['queued','uploading'].includes(job.status)) job.status='waiting'; notify(); },
    snapshot,
    close() { closed = true; clearTimeout(retryTimer); retryTimer = null; jobs.length = 0; while(idleWaiters.length) idleWaiters.shift()(); },
  };
}
