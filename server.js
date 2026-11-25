const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PLANS = process.env.PLANS_DIR || path.join(__dirname, 'plans');
fs.mkdirSync(PLANS, { recursive: true });

app.use(express.json({ limit: '300mb' }));

// Keep file names safe: no slashes, no traversal.
const clean = n => String(n).replace(/[^\w\- .()]/g, '_').replace(/^\.+/, '').trim().slice(0, 100) || 'untitled';
const file = n => path.join(PLANS, clean(n) + '.json');

app.get('/api/version', (_q, r) => r.json({ version: require('./package.json').version }));

app.get('/api/projects', (_q, r) => {
  const list = fs.readdirSync(PLANS).filter(f => f.endsWith('.json')).map(f => {
    const st = fs.statSync(path.join(PLANS, f));
    return { name: f.slice(0, -5), modified: st.mtimeMs, size: st.size };
  }).sort((a, b) => b.modified - a.modified);
  r.json(list);
});

app.get('/api/projects/:n', (q, r) => {
  const f = file(q.params.n);
  if (!fs.existsSync(f)) return r.status(404).send('Not found');
  r.type('json').send(fs.readFileSync(f));
});

app.put('/api/projects/:n', (q, r) => {
  try {
    const f = file(q.params.n), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(q.body));
    fs.renameSync(tmp, f);
    r.json({ ok: true, name: path.basename(f, '.json') });
  } catch (e) { r.status(500).send(e.message); }
});

app.delete('/api/projects/:n', (q, r) => {
  const f = file(q.params.n);
  if (!fs.existsSync(f)) return r.status(404).send('Not found');
  fs.unlinkSync(f);
  r.json({ ok: true });
});

// Libraries are served locally so the app works fully offline.
app.use('/lib/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/build')));
app.use('/lib/jspdf', express.static(path.join(__dirname, 'node_modules/jspdf/dist')));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(3000, () => console.log('CamPlan running on :3000, plans in ' + PLANS));
