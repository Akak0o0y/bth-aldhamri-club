export async function applyVideoEncoding(sender, { videoKbps, fps, contentHint }) {
  const configure = (preference) => {
    const params = sender.getParameters();
    if (!params.encodings?.length) throw new Error('Video sender has no negotiated encoding');
    for (const enc of params.encodings) {
      enc.maxBitrate = videoKbps * 1000;
      enc.maxFramerate = fps;
      enc.scaleResolutionDownBy = 1;
    }
    if (preference) params.degradationPreference = contentHint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
    else delete params.degradationPreference;
    return params;
  };
  try {
    await sender.setParameters(configure(true));
  } catch {
    // A fresh transactionId is required even for an optional-field retry.
    // Propagate the second failure: the UI must not claim a setting applied.
    await sender.setParameters(configure(false));
  }
}
