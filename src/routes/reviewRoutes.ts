// backend/src/routes/reviewRoutes.ts
//
// Public testimonials.
//
//   PUBLIC
//     GET    /api/reviews              approved reviews + aggregate
//     POST   /api/reviews              submit one, lands as `pending`
//
//   ADMIN (everything below router.use(protect, adminOnly))
//     GET    /api/reviews/all          every review + status counts
//     PATCH  /api/reviews/:id/status   approve / reject / back to pending
//     PATCH  /api/reviews/:id          edit text, name, role, rating, featured
//     DELETE /api/reviews/:id
//
// Nothing a visitor writes goes live on its own. A new row is `pending`
// until an admin approves it, which keeps spam and competitor abuse off
// the home page and out of Google's index.
//
// The public GET is the only endpoint the website calls, and it never
// returns email, phone, IP or user agent.

import { Router } from 'express';
import { prisma } from '../config/prisma.js';
import { protect, adminOnly } from '../middleware/auth.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */

const MAX_TEXT = 900;
const MIN_TEXT = 15;
const MAX_NAME = 80;
const MAX_ROLE = 120;

/** the client's address, behind nginx or any proxy */
const ipOf = (req: any): string => {
  const fwd = String(req.headers['x-forwarded-for'] || '');
  if (fwd) return fwd.split(',')[0].trim();
  return String(req.ip || req.socket?.remoteAddress || '');
};

const clean = (v: unknown, max: number): string =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** 1 to 5, anything else falls back to 5 */
const asRating = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 5;
};

/** what the public is allowed to see */
const publicFields = {
  id: true,
  name: true,
  role: true,
  rating: true,
  text: true,
  featured: true,
  createdAt: true,
} as const;

/* --- rate limit -----------------------------------------------------
   In memory on purpose: one small backend process, and a restart
   clearing the counters is harmless here. Swap for Redis only if the
   backend is ever run as more than one instance.                     */

const WINDOW_MS = 60 * 60 * 1000; // one hour
const MAX_PER_WINDOW = 3;
const hits = new Map<string, number[]>();

const rateLimited = (ip: string): boolean => {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
};

/* the map would grow forever on a long running process, so sweep it */
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    const recent = times.filter((t) => now - t < WINDOW_MS);
    if (recent.length) hits.set(ip, recent);
    else hits.delete(ip);
  }
}, WINDOW_MS).unref?.();

/* ------------------------------------------------------------------ */
/*  PUBLIC                                                             */
/*  These two sit ABOVE the guard, so they need no login.              */
/* ------------------------------------------------------------------ */

/** GET /api/reviews — approved reviews plus the aggregate for SEO */
router.get('/', async (req, res) => {
  try {
    const take = Math.min(Math.max(Number(req.query.limit) || 24, 1), 100);

    const rows = await prisma.review.findMany({
      where: { status: 'approved' },
      orderBy: [{ featured: 'desc' }, { createdAt: 'desc' }],
      take,
      select: publicFields,
    });

    /* the aggregate counts EVERY approved review, not just the page
       above, so the rating Google sees matches the real total */
    const groups = await prisma.review.groupBy({
      by: ['rating'],
      where: { status: 'approved' },
      _count: { _all: true },
    });

    let count = 0;
    let sum = 0;
    const breakdown: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    for (const g of groups) {
      const n = g._count._all;
      count += n;
      sum += g.rating * n;
      breakdown[String(g.rating)] = n;
    }

    const average = count ? Math.round((sum / count) * 10) / 10 : 0;

    res.json({ reviews: rows, average, count, breakdown });
  } catch (err) {
    console.error('GET /api/reviews failed:', err);
    res.status(500).json({ message: 'Could not load reviews' });
  }
});

/** POST /api/reviews — anyone can submit, it lands as pending */
router.post('/', async (req, res) => {
  try {
    const ip = ipOf(req);
    const {
      name,
      role,
      rating,
      text,
      email,
      phone,
      /* honeypot: hidden in the form, only a bot fills it */
      company,
      /* ms the form was open before submit, set by the frontend */
      elapsed,
    } = req.body || {};

    /* A bot gets the same cheerful answer as a human, so it cannot
       learn which check caught it and tune around it. Nothing saved. */
    const decoy = () =>
      res.status(201).json({ message: 'Thank you, your review has been sent for approval.' });

    if (clean(company, 40)) return decoy();
    if (Number(elapsed) > 0 && Number(elapsed) < 2500) return decoy();
    if (rateLimited(ip)) return decoy();

    const cleanName = clean(name, MAX_NAME);
    const cleanText = clean(text, MAX_TEXT);

    if (cleanName.length < 2) {
      return res.status(400).json({ message: 'Please enter your name.' });
    }
    if (cleanText.length < MIN_TEXT) {
      return res.status(400).json({ message: `Please write at least ${MIN_TEXT} characters.` });
    }

    /* the same text from the same address inside a day is a repeat
       submit, usually a double click or a bot retry */
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dupe = await prisma.review.findFirst({
      where: { ip, text: cleanText, createdAt: { gte: dayAgo } },
      select: { id: true },
    });
    if (dupe) return decoy();

    await prisma.review.create({
      data: {
        name: cleanName,
        role: clean(role, MAX_ROLE),
        rating: asRating(rating),
        text: cleanText,
        email: clean(email, 160),
        phone: clean(phone, 24),
        ip,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
        status: 'pending',
      },
    });

    res.status(201).json({ message: 'Thank you, your review has been sent for approval.' });
  } catch (err) {
    console.error('POST /api/reviews failed:', err);
    res.status(500).json({ message: 'Could not save your review, please try again.' });
  }
});

/* ------------------------------------------------------------------ */
/*  ADMIN                                                              */
/*  Everything below needs a logged in admin.                          */
/* ------------------------------------------------------------------ */

router.use(protect, adminOnly);

/** GET /api/reviews/all — moderation list with status counts */
router.get('/all', async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const q = String(req.query.q || '').trim();

    const where: any = {};
    if (status === 'pending' || status === 'approved' || status === 'rejected') {
      where.status = status;
    }
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { role: { contains: q, mode: 'insensitive' } },
        { text: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
      ];
    }

    const [rows, grouped] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        take: 300,
        include: { approvedBy: { select: { id: true, name: true } } },
      }),
      prisma.review.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const counts = { pending: 0, approved: 0, rejected: 0, total: 0 };
    for (const g of grouped) {
      counts[g.status as keyof typeof counts] = g._count._all;
      counts.total += g._count._all;
    }

    res.json({ reviews: rows, counts });
  } catch (err) {
    console.error('GET /api/reviews/all failed:', err);
    res.status(500).json({ message: 'Could not load reviews' });
  }
});

/** PATCH /api/reviews/:id/status — approve, reject, or send back to pending */
router.patch('/:id/status', async (req, res) => {
  try {
    const status = String(req.body?.status || '');
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'status must be pending, approved or rejected' });
    }

    const actorId = (req as any).user?.id || null;

    const review = await prisma.review.update({
      where: { id: req.params.id },
      data: {
        status: status as any,
        approvedAt: status === 'approved' ? new Date() : null,
        approvedById: status === 'approved' ? actorId : null,
      },
      include: { approvedBy: { select: { id: true, name: true } } },
    });

    res.json(review);
  } catch (err) {
    console.error('PATCH /api/reviews/:id/status failed:', err);
    res.status(500).json({ message: 'Could not update the review' });
  }
});

/** PATCH /api/reviews/:id — fix a typo, trim the text, pin it to the front */
router.patch('/:id', async (req, res) => {
  try {
    const { name, role, rating, text, featured, email, phone } = req.body || {};
    const data: any = {};

    if (name !== undefined) data.name = clean(name, MAX_NAME);
    if (role !== undefined) data.role = clean(role, MAX_ROLE);
    if (text !== undefined) data.text = clean(text, MAX_TEXT);
    if (rating !== undefined) data.rating = asRating(rating);
    if (featured !== undefined) data.featured = Boolean(featured);
    if (email !== undefined) data.email = clean(email, 160);
    if (phone !== undefined) data.phone = clean(phone, 24);

    if (data.name !== undefined && data.name.length < 2) {
      return res.status(400).json({ message: 'Name is too short' });
    }
    if (data.text !== undefined && data.text.length < MIN_TEXT) {
      return res.status(400).json({ message: `Review must be at least ${MIN_TEXT} characters` });
    }
    if (!Object.keys(data).length) {
      return res.status(400).json({ message: 'Nothing to update' });
    }

    const review = await prisma.review.update({
      where: { id: req.params.id },
      data,
      include: { approvedBy: { select: { id: true, name: true } } },
    });

    res.json(review);
  } catch (err) {
    console.error('PATCH /api/reviews/:id failed:', err);
    res.status(500).json({ message: 'Could not update the review' });
  }
});

/** DELETE /api/reviews/:id */
router.delete('/:id', async (req, res) => {
  try {
    await prisma.review.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/reviews/:id failed:', err);
    res.status(500).json({ message: 'Could not delete the review' });
  }
});

export default router;