import { Router } from 'express';
import { postApprovalToSlack, handleSlackAction, buildDecisionBlocks, SlackActionPayload } from './slack';

export const slackRouter = Router();

// Trigger approval notification to Slack
// POST /api/v1/slack/notify-approval
// Body: { approval_id: "..." }
slackRouter.post('/notify-approval', async (req, res) => {
  try {
    const { approval_id } = req.body;
    if (!approval_id) return res.status(400).json({ error: 'approval_id required' });
    
    const result = await postApprovalToSlack(approval_id);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Slack interactive endpoint (button clicks)
// Slack sends POST with Content-Type: application/x-www-form-urlencoded and payload=JSON
slackRouter.post('/interactive', async (req, res) => {
  try {
    console.log('[slack/interactive] Received interactive request from Slack');
    const payloadStr = req.body.payload;
    if (!payloadStr) {
      console.warn('[slack/interactive] Missing payload body');
      return res.status(400).json({ error: 'payload required' });
    }
    
    const payload = JSON.parse(payloadStr) as any;
    console.log('[slack/interactive] Action type:', payload.type, 'user:', payload.user?.username || payload.user?.name);
    
    const result = await handleSlackAction(payload);
    
    if (!result.ok) {
      console.warn('[slack/interactive] Decision failed:', result.error);
      return res.json({
        response_type: 'ephemeral',
        replace_original: false,
        text: `⚠️ ${result.error}`,
      });
    }
    
    console.log(`[slack/interactive] Approval ${result.approval_id} decided as ${result.decision}`);

    // Update original message so buttons disappear and show the decision
    const originalBlocks = payload.message?.blocks || [];
    const decidedBy = payload.user?.name || payload.user?.username || 'Human';
    const updatedBlocks = buildDecisionBlocks(result.approval_id!, result.decision!, decidedBy, originalBlocks);

    // Post to response_url if present
    if (payload.response_url) {
      try {
        await fetch(payload.response_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            replace_original: true,
            text: `Approval ${result.decision} by ${decidedBy}`,
            blocks: updatedBlocks,
          }),
        });
      } catch (postErr) {
        console.error('[slack/interactive] Failed to POST to response_url:', postErr);
      }
    }

    return res.json({
      replace_original: true,
      text: `Approval ${result.decision} by ${decidedBy}`,
      blocks: updatedBlocks,
    });
  } catch (err: any) {
    console.error('[slack/interactive] Error:', err);
    res.status(500).json({ error: err.message });
  }
});
