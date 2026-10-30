const DEFAULTS = {
  notifications: true,
  notifyAttention: true,
  notifyConnections: true,
  notificationSound: false,
  notificationReminders: true,
  attentionBadge: true,
};
const keyFor = (i) =>
  `${i.id}:${i.kind}:${['approval', 'blocking'].includes(i.kind) ? i.jobId || '' : i.generation || ''}`;
const REMINDER_MS = 30 * 60 * 1000;
class AttentionNotifier {
  constructor({ send, badge, persist = () => {}, saved = {}, clock = Date.now }) {
    Object.assign(this, { send, badge, persist, clock });
    this.sent = saved.sent || {};
    this.connectionsNotified = !!saved.connectionsNotified;
    this.prefs = { ...DEFAULTS };
    this.snapshot = { items: [], connectionsChecked: false };
    this.lastBatch = 0;
    this.retryAfter = 0;
  }
  configure(prefs) {
    this.prefs = { ...DEFAULTS, ...prefs };
    this.update(this.snapshot);
  }
  update(snapshot) {
    this.snapshot = snapshot;
    this.badge(this.prefs.attentionBadge ? snapshot.items.length : 0, snapshot.items.length);
  }
  save() {
    const cutoff = this.clock() - 7 * 24 * 60 * 60 * 1000;
    this.sent = Object.fromEntries(
      Object.entries(this.sent)
        .filter(([, t]) => t >= cutoff)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5000),
    );
    this.persist({ sent: this.sent, connectionsNotified: this.connectionsNotified });
  }
  async flush() {
    if (this.flushing || !this.prefs.notifications || this.clock() < this.retryAfter) return;
    this.flushing = true;
    try {
      const now = this.clock();
      const eligible = this.snapshot.items.filter((i) =>
        i.category === 'connection' ? this.prefs.notifyConnections : this.prefs.notifyAttention,
      );
      const due = eligible.filter((i) => {
        const sent = this.sent[keyFor(i)];
        return (
          sent === undefined || (this.prefs.notificationReminders && now - sent >= REMINDER_MS)
        );
      });
      const urgent = due.some(
        (i) => i.category === 'connection' && this.sent[keyFor(i)] === undefined,
      );
      if (due.length && (urgent || !this.lastBatch || now - this.lastBatch >= 60000)) {
        const connections = due.filter((i) => i.category === 'connection');
        const title = due.length === 1 ? due[0].title : `${due.length} items need attention`;
        const body = connections.length
          ? `${connections.map((i) => i.title).join('. ')}. Open Review Studio for details and recovery status.`
          : 'Open Review Studio to inspect reviews and operations that need attention.';
        const page = due.every((i) => i.page === due[0].page) ? due[0].page : 'activity';
        this.lastBatch = now;
        if (await this.send({ title, body, page, silent: !this.prefs.notificationSound })) {
          for (const i of due) this.sent[keyFor(i)] = now;
          if (connections.length) this.connectionsNotified = true;
          this.save();
        } else this.retryAfter = now + REMINDER_MS;
      } else if (
        this.connectionsNotified &&
        this.prefs.notifyConnections &&
        this.snapshot.connectionsChecked &&
        !this.snapshot.items.some((i) => i.category === 'connection')
      ) {
        if (
          await this.send({
            title: 'Connections restored',
            body: 'GitHub, Claude and Git are ready. Your runner settings have not changed.',
            page: 'settings',
            silent: !this.prefs.notificationSound,
          })
        ) {
          this.connectionsNotified = false;
          for (const key of Object.keys(this.sent))
            if (key.startsWith('connection:') || key.startsWith('engine:')) delete this.sent[key];
          this.save();
        } else this.retryAfter = now + REMINDER_MS;
      }
    } finally {
      this.flushing = false;
    }
  }
}
module.exports = { AttentionNotifier, DEFAULTS, REMINDER_MS };
