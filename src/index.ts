import type { Pool } from 'pg';
import type { Api } from './lib/api.ts';
import type { EventSnapshot, IssueTickets } from './lib/contracts.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { conflict, notFound } from './lib/api.ts';
import { env } from './lib/config.ts';
import { transaction } from './lib/db.ts';

const customer = { role: 'cliente' } as const;
const ticketLock = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const batchTickets = 'SELECT * FROM tickets WHERE order_id=$1 ORDER BY ordinal';

interface TicketRow {
  id: string;
  order_id: string;
  code: string;
}

interface BatchRow {
  request: IssueTickets;
  ready: boolean;
}

function canonicalRequest(ticket: IssueTickets): IssueTickets {
  return {
    ...ticket,
    customerId: ticket.customerId.toLowerCase(),
    eventId: ticket.eventId.toLowerCase(),
    sectorId: ticket.sectorId.toLowerCase(),
  };
}

function filename(id: string) {
  return join(env('TICKETS_PDF_DIR'), id + '.pdf');
}

function ticketView(row: Pick<TicketRow, 'id' | 'order_id'>, event: EventSnapshot) {
  const { eventId, eventName, eventDate, eventVenue, sectorName } = event;
  return {
    id: row.id, orderId: row.order_id, eventId, eventName, eventDate, eventVenue, sectorName,
    pdfUrl: `/api/tickets/${row.id}/pdf`,
  };
}

async function writePdf(row: TicketRow, event: EventSnapshot) {
  const qr = await QRCode.toBuffer(row.code, { width: 240 });
  const pdfPath = filename(row.id);
  const tempPath = `${pdfPath}.${randomUUID()}.tmp`;
  const doc = new PDFDocument({ size: 'A5' });
  const writing = pipeline(doc, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
  try {
    doc.fontSize(20).text('EntradasYa');
    doc.moveDown().fontSize(16).text(event.eventName);
    doc.fontSize(12).text(event.eventDate).text(event.eventVenue).text(event.sectorName);
    doc.moveDown().image(qr, { width: 140 });
    doc.moveDown().fontSize(9).text(row.code);
    doc.end();
    await writing;
    await rename(tempPath, pdfPath);
  } catch (error) {
    doc.destroy();
    await writing.catch(() => {});
    await rm(tempPath, { force: true });
    throw error;
  }
}

export function mount(api: Api, { pool }: { pool: Pool }) {
  api.route<IssueTickets>('issueTickets', { token: 'TICKETS_ORDERS_TOKEN' }, async (req, res) => {
    const orderId = req.params.orderId.toLowerCase();
    const data = canonicalRequest(req.body);
    await transaction(pool, async (client) => {
      await client.query(ticketLock, [orderId]);
      const { rows: [batch] } = await client.query<Pick<BatchRow, 'request'>>(
        'SELECT request FROM ticket_batches WHERE order_id=$1', [orderId],
      );
      if (batch) {
        if (!isDeepStrictEqual(canonicalRequest(batch.request), data)) {
          throw conflict('TICKET_CONFLICT', 'El lote ya tiene otros datos.');
        }
        return;
      }
      await client.query(
        'INSERT INTO ticket_batches (order_id, customer_id, event_id, request) VALUES ($1,$2,$3,$4)',
        [orderId, data.customerId, data.eventId, data],
      );
      for (let ordinal = 1; ordinal <= data.quantity; ordinal += 1) {
        await client.query('INSERT INTO tickets (order_id, ordinal, code) VALUES ($1,$2,$3)',
          [orderId, ordinal, randomBytes(24).toString('base64url')]);
      }
    });
    const items = await transaction(pool, async (client) => {
      await client.query(ticketLock, [orderId]);
      const { rows: [batch] } = await client.query<BatchRow>(
        'SELECT ready, request FROM ticket_batches WHERE order_id=$1', [orderId],
      );
      const event = canonicalRequest(batch.request);
      const { rows } = await client.query<TicketRow>(batchTickets, [orderId]);
      if (!batch.ready) {
        for (const row of rows) await writePdf(row, event);
        await client.query('UPDATE ticket_batches SET ready=true WHERE order_id=$1', [orderId]);
      }
      return rows.map((row) => ticketView(row, event));
    });
    res.json({ items });
  });

  api.route('listOwnTickets', customer, async (req, res) => {
    const { rows } = await pool.query<Pick<TicketRow, 'id' | 'order_id'> & Pick<BatchRow, 'request'>>(
      `SELECT t.id, t.order_id, b.request FROM tickets t JOIN ticket_batches b USING (order_id)
       WHERE b.ready AND b.customer_id=$1 AND ($2::uuid IS NULL OR b.order_id=$2)
       ORDER BY t.order_id, t.ordinal`,
      [req.actor.sub, req.query.orderId ?? null],
    );
    res.json({ items: rows.map((row) => ticketView(row, canonicalRequest(row.request))) });
  });

  api.route('downloadOwnTicket', customer, async (req, res) => {
    const { rows: [row] } = await pool.query(
      `SELECT t.id FROM tickets t JOIN ticket_batches b USING (order_id)
       WHERE b.ready AND b.customer_id=$1 AND t.id=$2`,
      [req.actor.sub, req.params.ticketId],
    );
    if (!row) throw notFound();
    const contents = await readFile(filename(row.id));
    res.set('Cache-Control', 'private, no-store').attachment(row.id + '.pdf').send(contents);
  });

  api.route<{ code: string }>('lookupTicket', { token: 'TICKETS_CHECKIN_TOKEN' }, async (req, res) => {
    const { rows: [row] } = await pool.query(
      'SELECT t.id, b.event_id FROM tickets t JOIN ticket_batches b USING (order_id) WHERE b.ready AND t.code=$1',
      [req.body.code],
    );
    if (!row) throw notFound();
    res.json({ ticketId: row.id, eventId: row.event_id });
  });
}
