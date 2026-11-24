# Shared GitHub workflows

`actions/capture-image-v1` and `.github/workflows/notify-image-v1.yml` connect a successful GHCR push to a Services publication notification. They do not build, push, retag, deploy, or query a registry. GitHub.com is required: same-repository `$/` references resolve at the commit of the workflow or composite action that contains them.

## Caller integration

Pin **both** entries to the same reviewed, full commit SHA of this repository. In this example, `COMMON_COMMIT_SHA` is a placeholder for that external pin. Add the capture step immediately after the successful image push. The example assumes the existing `publish` job has a `push` step with `outputs.digest`, the exact pushed tag list comes from `meta`, and the numeric build number comes from `build_version`.

```yaml
# Add to the existing publish job:
outputs:
  services_artifact: ${{ steps.services_capture.outputs.artifact }}
steps:
  # Existing version, metadata and successful image push steps go here.
  - name: Capture the image that was just pushed
    id: services_capture
    uses: everyonesoftware/workflows-common/actions/capture-image-v1@COMMON_COMMIT_SHA
    with:
      digest: ${{ steps.push.outputs.digest }}
      tags: ${{ steps.meta.outputs.tags }}
      version: ${{ steps.build_version.outputs.number }}
```

```yaml
# Add under jobs in the same caller workflow:
notify_services:
  needs: publish
  if: ${{ !cancelled() && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main' && needs.publish.result == 'success' && needs.publish.outputs.services_artifact != '' && vars.SERVICES_PUBLISH_NOTIFICATIONS == 'true' }}
  uses: everyonesoftware/workflows-common/.github/workflows/notify-image-v1.yml@COMMON_COMMIT_SHA
  permissions:
    contents: read
    id-token: write
  with:
    artifact: ${{ needs.publish.outputs.services_artifact }}
    services-url: ${{ vars.SERVICES_PUBLISH_URL }}
    tailscale-client-id: ${{ vars.TAILSCALE_CLIENT_ID }}
    tailscale-audience: ${{ vars.TAILSCALE_AUDIENCE }}
    tailscale-tags: ${{ vars.TAILSCALE_TAGS }}
  secrets:
    services-token: ${{ secrets.SERVICES_PUBLISH_TOKEN }}
```

- `digest` is the successful push's root `sha256:` digest. `tags` is a newline-separated list of full `ghcr.io/owner/image:tag` references for one image, with no blank lines or duplicates. Do not infer tags, including `latest`. `version` is a positive decimal build number without leading zeros, not a semantic version.
- For Services to recognize the integration, use the capture step ID and artifact output shown above, and replace `main` with the repository's actual default branch if different. The producer job ID can differ; use it consistently in `needs` and the notification condition and input.
- Run capture only when the image was really published, not for dry runs, native-only runs, or a maintenance re-promotion of an older build. For a conditional step, explicitly check the push step's successful outcome and its actual publication gate. Keep native jobs out of `notify_services.needs` unless they are part of the image publication prerequisite; skipped native jobs alone must not block delivery. Restrict the publish job to trusted events and refs (for example, pushes to a protected branch). Do not pass publisher credentials to any PR-triggered job, including `pull_request_target`.
- To include `sourceRepositoryId`, set `SERVICES_PUBLISH_IDENTITY_VERSION: '1'` in the capture step's `env` **only after** the receiver accepts that optional field. The legacy schema is the default. The receiver must independently authorize every image and source; the optional ID is not proof of ownership.

## Trust and retry behavior

Capture writes one `published.json` containing the push metadata and GitHub caller provenance. The `artifact` output is exposed only after successful upload as `services-publish-<run-id>-<attempt>`, with no overwrite and 30-day retention. The notifier checks the name before downloading from the same workflow run, treats an archive digest mismatch as an error, and validates the envelope against the caller repository, SHA, ref, run ID, and the capture attempt encoded in the name. A previous attempt in the same run is allowed for a failed-job rerun; another run or a future attempt is not. Missing or expired artifacts fail closed. This validates run provenance, not the truth of a trusted producer's claims about the registry.

The notify job checks no caller code out. It joins Tailscale using workload identity federation and posts the retained JSON bytes to the configured HTTPS `/api/images/published` endpoint. Configure the identity provider to trust only the intended caller and workflow/ref claims; use a least-privilege tailnet tag and image-scoped publisher token. The token is passed only to the send step. No authentication data is stored in the artifact. Redirects are not followed; `accepted`, `duplicate`, and `stale` acknowledge delivery. Timeouts, selected network failures, HTTP 408/429, and HTTP 5xx receive bounded retries with the same bytes. A permanent rejection or malformed acknowledgement fails notification without undoing the image push. **Re-run failed jobs** to retry the original notification without republishing when the producer already succeeded.

## Verification

Run `node --test tests/*.test.mjs` with Node.js 24. The validation workflow runs the unit tests on PRs and pushes. On pushes and manual runs it also captures, uploads, downloads, and validates a simulated publication across jobs without checking out source in those jobs, accessing GHCR, joining a tailnet, or delivering a notification. This smoke test does not validate production federation or Services connectivity.

The envelope validation and HTTP delivery implementation are adapted from the Services sender (`everyonesoftware/services`, `scripts/publish-notification.mjs`, commit `267899f7e6439d9e64942459280ef77115ef02c4`).
