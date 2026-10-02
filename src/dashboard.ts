import { Router } from 'express';
import path from 'path';

export const dashboardRouter = Router();

dashboardRouter.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

dashboardRouter.get('/', (_req, res) => {
  res.redirect('/dashboard');
});
