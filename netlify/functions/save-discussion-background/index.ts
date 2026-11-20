import type { HandlerEvent } from '@netlify/functions';
import crypto from 'crypto';
import querystring from 'querystring';

import { Repository } from './Reposity';
import { Slack } from './Slack';

enum REQUEST_TYPE {
  MESSAGE_ACTION = 'message_action',
  DIALOG_SUBMISSION = 'dialog_submission',
}
const REPO_OWNER = process.env.DISCUSSION_TARGET_REPO_OWNER;
const REPO_NAME = process.env.DISCUSSION_TARGET_REPO_NAME;

const MAX_REQUEST_AGE_SECONDS = 60 * 5;
const SLACK_ID_PATTERN = /^[A-Z0-9]{1,32}$/;
const SLACK_TS_PATTERN = /^\d{1,12}\.\d{1,8}$/;

/**
 * Verifies that the request really comes from Slack (https://api.slack.com/authentication/verifying-requests-from-slack).
 * Without this check anybody on the internet could invoke this function with a forged payload.
 */
function isValidSlackRequest(event: HandlerEvent, rawBody: string): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const signature = event.headers['x-slack-signature'];
  const timestamp = event.headers['x-slack-request-timestamp'];

  if (!signingSecret || !signature || !timestamp) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));

  if (!Number.isFinite(age) || age > MAX_REQUEST_AGE_SECONDS) return false;

  const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Function to handle the main request handling logic.
const handler = async (event: HandlerEvent) => {
  // since slack always sends Only POST methods along with a body, we can ignore all other requests.
  if (event.httpMethod != 'POST' || !event.body) {
    return;
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  if (!isValidSlackRequest(event, rawBody)) {
    console.error('Rejected request with missing or invalid Slack signature.');

    return;
  }

  // Slack encodes the body in application/x-www-form-urlencoded
  let payload: any;

  try {
    payload = JSON.parse(querystring.parse(rawBody)?.payload as string);
  } catch {
    console.error('Rejected request with malformed payload.');

    return;
  }

  // When the `Save Discussion` option selected in slack.
  if (payload.type === REQUEST_TYPE.MESSAGE_ACTION) {
    await handleMessageAction(payload);
    // When the user submits the dialog.
  } else if (payload.type === REQUEST_TYPE.DIALOG_SUBMISSION) {
    await handleDialogSubmission(payload);
  }
};

async function handleMessageAction(payload: any) {
  const channelId = payload.channel.id;
  const threadTS = payload.message.thread_ts;

  if (!threadTS) {
    const errorMessage =
      'Unable to save this discussion since it has no replies.';

    await Slack.sendResponse(payload.response_url, errorMessage);

    return;
  }

  const discussionCategories = await Repository.getDiscussionCategories(REPO_OWNER!,
    REPO_NAME!);
  const state = `${channelId} ${threadTS}`;

  await Slack.openSaveDialog(state, discussionCategories, payload.trigger_id);
}
async function handleDialogSubmission(payload: any) {
  const dialogState = String(payload.state ?? '').split(' ');
  const channelId = dialogState[0];
  const threadTS = dialogState[1];

  if (!SLACK_ID_PATTERN.test(channelId) || !SLACK_TS_PATTERN.test(threadTS)) {
    console.error('Rejected dialog submission with invalid state.');

    return;
  }

  try {
    const discussion = await Slack.getSlackDiscussion(channelId, threadTS);

    const categoryId = payload.submission.category;

    if (!discussion) return;
    discussion.title = payload.submission.title;
    const repositoryId = await Repository.getRepositoryId(process.env.DISCUSSION_TARGET_REPO_OWNER!,
      process.env.DISCUSSION_TARGET_REPO_NAME!);
    const { discussionId, discussionURL } = await Repository.createDiscussion(discussion,
      repositoryId,
      categoryId,
      discussion.slackURL || '');

    if (discussion.replies) {
      for (const reply of discussion.replies) {
        const replyId = await Repository.createDicussionReply(discussionId,
          reply);

        if (reply.isAnswer) {
          await Repository.markAnswer(replyId);
        }
      }
    }
    const message = `Thanks to <@${payload.user.id}>, this discussion has been preserved here: ${discussionURL}`;

    await Slack.postReplyInThread(message, channelId, threadTS);
  } catch (e) {
    let errorMessage;

    switch (e.data?.error) {
      case 'missing_scope':
        errorMessage =
          'Sorry, This operation is only supposed to be used in public channels.';
        break;
      case 'channel_not_found':
        errorMessage =
          'Can\'t find the channel, are you sure that this is a public channel?';
        break;
      case 'not_in_channel':
        errorMessage =
          'Can\'t access this channel. Are you sure that I am a member of this channel? please add `BotTheSavior` in integration settings of this channel. :)';
        break;
    }

    await Slack.sendResponse(payload.response_url, errorMessage);
    console.error(e);
  }
}

export { handler };
