import { query } from './db';

export interface TaskLog {
  id: string;
  task_id: string;
  timestamp: string;
  level: TaskLogLevel;
  message: string;
}

export type TaskLogLevel = 'info' | 'warn' | 'error' | 'pause' | 'stdout' | 'success';

export async function appendTaskLog(taskId: string, message: string, level: TaskLogLevel = 'info'): Promise<TaskLog> {
  const rows = await query(
    `INSERT INTO task_logs (task_id, level, message, timestamp)
     VALUES ($1, $2, $3, now())
     RETURNING *`,
    [taskId, level, message]
  );
  return rows[0];
}

export async function getTaskLogs(taskId: string): Promise<TaskLog[]> {
  const rows = await query(
    `SELECT * FROM task_logs WHERE task_id = $1 ORDER BY timestamp ASC`,
    [taskId]
  );
  return rows;
}
