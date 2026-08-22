import {
  DouyinPublicCommentProviderError,
  createDouyinPublicCommentProvider
} from "./douyin-public-comment-provider.js";

const videoId = process.env.DOUYIN_VIDEO_ID?.trim();
if (process.env.DOUYIN_PUBLIC_COMMENT_SMOKE !== "1" || !videoId) {
  console.error(
    "No network request made. Set DOUYIN_PUBLIC_COMMENT_SMOKE=1 and DOUYIN_VIDEO_ID=<digits> to run this opt-in smoke check."
  );
  process.exitCode = 1;
} else if (!/^\d+$/u.test(videoId)) {
  console.error("DOUYIN_VIDEO_ID must contain digits only; no network request made.");
  process.exitCode = 1;
} else {
  const provider = createDouyinPublicCommentProvider();
  try {
    const page = await provider.fetchTopLevelSample({
      videoId,
      sourceUrl: `https://www.douyin.com/video/${videoId}`,
      cursor: 0,
      count: 20
    });
    console.log(JSON.stringify({
      commentCount: page.comments.length,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      reportedCommentCount: page.reportedCommentCount,
      rawArtifactHash: page.rawArtifactHash,
      providerVersion: page.providerVersion,
      coverage: page.coverage
    }));
  } catch (error) {
    const code = error instanceof DouyinPublicCommentProviderError
      ? error.code
      : "public_sample_unavailable";
    console.error(JSON.stringify({ code }));
    process.exitCode = 1;
  }
}
