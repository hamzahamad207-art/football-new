// Threads Graph API client.
//
// Threads flow:
//   1. POST /v1.0/{user_id}/threads  -> create a "media container" (returns container_id)
//   2. POST /v1.0/{container_id}/publish  -> actually publish the post (returns post_id)
//
// Env vars needed:
//   THREADS_ACCESS_TOKEN — your Threads long-lived access token
//   THREADS_USER_ID      — your Threads user id (numeric)
//
// Docs: https://developers.facebook.com/docs/threads

const BASE = 'https://graph.threads.net/v1.0';

export function getThreadsConfig() {
  const accessToken = process.env.THREADS_ACCESS_TOKEN;
  const userId = process.env.THREADS_USER_ID;
  if (!accessToken || !userId) {
    throw new Error(
      'Missing THREADS_ACCESS_TOKEN or THREADS_USER_ID env vars. ' +
        'Set them in your environment or in GitHub Secrets.'
    );
  }
  return { accessToken, userId };
}

/**
 * Create a Threads media container.
 * For an IMAGE post: media_type=IMAGE, image_url=URL, text=CAPTION
 * For a TEXT-only post: media_type=TEXT, text=CAPTION
 */
export async function createMediaContainer({ text, imageUrl }) {
  const { accessToken, userId } = getThreadsConfig();

  const body = new URLSearchParams({ access_token: accessToken, text });
  if (imageUrl) {
    body.set('media_type', 'IMAGE');
    body.set('image_url', imageUrl);
  } else {
    body.set('media_type', 'TEXT');
  }

  const url = `${BASE}/${userId}/threads`;
  console.log(`📡 Creating media container (${body.get('media_type')})...`);

  // Meta's Graph API expects form-encoded bodies (not JSON).
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const json = await res.json();
  if (!res.ok || !json.id) {
    throw new Error(
      `Threads createMediaContainer failed: ${res.status} ${JSON.stringify(json)}`
    );
  }
  console.log(`✅ container id: ${json.id}`);
  return json.id;
}

/**
 * Publish a previously-created media container to the feed.
 * Threads needs time to download and process the image before publishing.
 * We use a fixed delay of 8 seconds (commonly enough for Threads to finish).
 */
export async function publishMedia(containerId) {
  const { accessToken } = getThreadsConfig();

  // Wait for Threads to finish processing the image (8s delay)
  console.log(`   ⏳ Waiting 8s for Threads to process the image...`);
  await new Promise((r) => setTimeout(r, 8000));

  const url = `${BASE}/${containerId}/publish`;
  console.log(`📡 Publishing...`);

  const res = await fetch(`${url}?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST',
  });

  const json = await res.json();
  if (!res.ok || !json.id) {
    throw new Error(
      `Threads publish failed: ${res.status} ${JSON.stringify(json)}`
    );
  }
  console.log(`✅ posted! post id: ${json.id}`);
  return json.id;
}

/**
 * Convenience wrapper: create + publish in one call.
 */
export async function postToThreads({ text, imageUrl }) {
  const containerId = await createMediaContainer({ text, imageUrl });
  const postId = await publishMedia(containerId);
  return { postId, containerId };
}
