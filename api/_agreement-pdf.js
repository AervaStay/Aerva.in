// /api/_agreement-pdf.js — the agreement a person accepted, as a PDF they
// can keep. Not an endpoint.
//
// Owner, 14 Nov 2026: "agreement copy should be sent in pdf as attachment".
//
// Until now a guest was told in the confirmation email which version they
// had accepted and given a link to read it on the site. A link is not a
// copy: the page changes when the agreement changes, so a year later it no
// longer shows what they agreed to. This writes the text as it stood when
// they accepted it, with the version and the moment of acceptance on it.
//
// The text is read from aerva-policies.js, the same file the site shows
// and the same one _host-agreement.js reads, so there is one source for
// the words and no second copy to drift.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PDFDocument = require('pdfkit');

let CACHE = null;
function agreements() {
  if (CACHE) return CACHE;
  const tries = [path.join(process.cwd(), 'aerva-policies.js'), path.join(__dirname, '..', 'aerva-policies.js')];
  const file = tries.find(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
  if (!file) { CACHE = {}; return CACHE; }
  try {
    const box = { window: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), box, { timeout: 2000 });
    CACHE = (box.window.AERVA_POLICIES || {}).agreements || {};
  } catch (e) {
    console.error('agreement text could not be read for the PDF:', e.message);
    CACHE = {};
  }
  return CACHE;
}

// The two agreements, flattened to one shape: headings and paragraphs.
//
// They are not written the same way. The guest's is { title, points[] } —
// a flat list. The host's is { title, intro, clauses[], accept }, and each
// clause is itself { title, points[] }, so its text lives one level deeper.
// Reading a clause as if it were a paragraph produced a PDF with all 29
// headings and not one word under them.
const asText = (p) => (typeof p === 'string' ? p : (p && (p.p || p.text || '')) || '');
function flatten(items, out) {
  for (const it of items || []) {
    if (typeof it === 'string') { out.push({ text: it }); continue; }
    if (!it || typeof it !== 'object') continue;
    const heading = it.title || it.h || null;
    if (heading) out.push({ heading });
    if (Array.isArray(it.points)) for (const p of it.points) { const t = asText(p); if (t) out.push({ text: t }); }
    else { const t = asText(it); if (t) out.push({ text: t }); }
  }
  return out;
}
function parts(which) {
  // Only the two that exist. Falling through to the guest agreement for
  // anything else would attach the wrong document and look like it worked.
  if (which !== 'guest' && which !== 'host') return null;
  const A = agreements();
  if (which === 'host') {
    const h = A.host;
    if (!h || !Array.isArray(h.clauses)) return null;
    const body = [];
    if (h.intro) body.push({ text: String(h.intro) });
    flatten(h.clauses, body);
    if (h.accept) body.push({ text: String(h.accept) });
    return { title: h.title || 'Aerva Host Agreement', version: A.hostVersion || null, body };
  }
  const g = A.guest;
  if (!g || !Array.isArray(g.points)) return null;
  const body = [];
  if (g.intro) body.push({ text: String(g.intro) });
  flatten(g.points, body);
  return { title: g.title || 'Booking agreement', version: A.version || null, body };
}

const when = (d) => {
  const t = d ? new Date(d) : null;
  if (!t || isNaN(t.getTime())) return null;
  return t.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' (India time)';
};

// which: 'guest' | 'host'
//   version     the version actually accepted, which may be older than the
//               one in the file — it is printed as accepted, and a note
//               says so when they differ, rather than quietly showing
//               today's text under yesterday's number.
//   acceptedAt  when they accepted
//   name        who accepted
//   reference   the booking reference, for a guest
//
// Returns a Buffer, or null when the text cannot be read. Never throws:
// an email must go out even if its attachment cannot be built.
function agreementPdf(which, { version = null, acceptedAt = null, name = '', reference = null } = {}) {
  return new Promise((resolve) => {
    try {
      const a = parts(which);
      if (!a) return resolve(null);
      const doc = new PDFDocument({ margin: 56, size: 'A4' });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (e) => { console.error('agreement PDF failed:', e.message); resolve(null); });

      const shown = version || a.version;
      doc.fontSize(10).font('Helvetica').fillColor('#8a6c39').text('AERVA', { characterSpacing: 2 });
      doc.moveDown(0.4);
      doc.fontSize(20).font('Helvetica-Bold').fillColor('#1c1b19').text(a.title);
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor('#6e675d');
      const line = [shown ? `Version ${shown}` : null, when(acceptedAt) ? `Accepted ${when(acceptedAt)}` : null, name || null, reference ? `Booking ${reference}` : null]
        .filter(Boolean).join('  ·  ');
      if (line) doc.text(line);
      if (shown && a.version && shown !== a.version) {
        doc.moveDown(0.2);
        doc.fillColor('#a3402f').text(`This is the text of version ${a.version}. You accepted version ${shown}; ask Aerva for that text if you need it.`);
      }
      doc.moveDown(1);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#e3dcd0').stroke();
      doc.moveDown(1);

      for (const p of a.body) {
        if (p.heading) {
          doc.moveDown(0.4);
          doc.fontSize(11.5).font('Helvetica-Bold').fillColor('#1c1b19').text(String(p.heading));
          doc.moveDown(0.2);
        }
        if (p.text) {
          doc.fontSize(10.5).font('Helvetica').fillColor('#2b2924').text(String(p.text), { align: 'left', lineGap: 2.5 });
          doc.moveDown(0.5);
        }
      }

      doc.moveDown(1);
      doc.fontSize(9).font('Helvetica').fillColor('#8d867b')
        .text('This is a copy of the agreement as it stood when it was accepted, kept for your records. Aerva’s Policies are at aerva.in/index.html?view=policies.');
      doc.end();
    } catch (err) {
      console.error('agreement PDF failed:', err.message);
      resolve(null);
    }
  });
}

const fileName = (which) => which === 'host' ? 'aerva-host-agreement.pdf' : 'aerva-booking-agreement.pdf';

module.exports = { agreementPdf, fileName, parts };
