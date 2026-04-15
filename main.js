import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import * as artifact from '@actions/artifact'
import AdmZip from 'adm-zip'
import { filesize } from 'filesize'
import pathname from 'node:path'
import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import os from 'node:os'

async function downloadAction(name, path) {
    const artifactClient = artifact.create()
    const downloadOptions = {
        createArtifactFolder: false
    }
    const downloadResponse = await artifactClient.downloadArtifact(
        name,
        path,
        downloadOptions
    )
    core.setOutput("found_artifact", true)
}

/**
 * Resolves the final pre-signed download URL for an artifact by letting
 * Octokit attempt the request with redirects disabled, then following the
 * Location header ourselves so we never buffer the ZIP body in JS memory.
 */
async function getArtifactDownloadUrl(client, owner, repo, artifactId) {
    try {
        // Ask Octokit NOT to follow the redirect so we get the Location header.
        await client.rest.actions.downloadArtifact({
            owner,
            repo,
            artifact_id: artifactId,
            archive_format: "zip",
            request: { redirect: "manual" },
        })
    } catch (error) {
        // Octokit throws on 302 when redirects are disabled; grab the URL.
        if (error.status === 302 && error.response?.headers?.location) {
            return error.response.headers.location
        }
        // Some Octokit versions expose it differently.
        if (error.response?.headers?.location) {
            return error.response.headers.location
        }
        throw error
    }
    throw new Error("Expected a redirect response from downloadArtifact but got none")
}

/**
 * Streams a URL (following up to one redirect) straight to a file on disk.
 * Never holds the full body in Node.js heap memory.
 */
function streamUrlToFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const dest = fs.createWriteStream(destPath)

        const handleResponse = (res) => {
            // Follow a single redirect (the pre-signed Azure Blob URL may itself redirect).
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume() // drain the redirect body
                const redirectUrl = new URL(res.headers.location)
                const mod = redirectUrl.protocol === 'https:' ? https : http
                mod.get(res.headers.location, handleResponse).on('error', reject)
                return
            }
            if (res.statusCode !== 200) {
                reject(new Error(`Unexpected HTTP ${res.statusCode} while downloading artifact from ${url}`))
                res.resume()
                return
            }
            res.on('error', reject)
            res.pipe(dest)
            dest.on('finish', resolve)
            dest.on('error', reject)
        }

        const parsedUrl = new URL(url)
        const mod = parsedUrl.protocol === 'https:' ? https : http
        mod.get(url, handleResponse).on('error', reject)
    })
}

async function getWorkflow(client, owner, repo, runID) {
    const run = await client.rest.actions.getWorkflowRun({
        owner: owner,
        repo: repo,
        run_id: runID || github.context.runId,
    })
    return run.data.workflow_id
}

async function main() {
    try {
        const token = core.getInput("github_token", { required: true })
        const [owner, repo] = core.getInput("repo", { required: true }).split("/")
        const path = core.getInput("path", { required: true })
        const name = core.getInput("name")
        const nameIsRegExp = core.getBooleanInput("name_is_regexp")
        const skipUnpack = core.getBooleanInput("skip_unpack")
        const ifNoArtifactFound = core.getInput("if_no_artifact_found")
        const useUnzip = core.getBooleanInput("use_unzip")
        const mergeMultiple = core.getBooleanInput("merge_multiple")
        let workflow = core.getInput("workflow")
        let workflowSearch = core.getBooleanInput("workflow_search")
        let workflowConclusion = core.getInput("workflow_conclusion")
        let pr = core.getInput("pr")
        let commit = core.getInput("commit")
        let branch = core.getInput("branch")
        let ref = core.getInput("ref")
        let event = core.getInput("event")
        let runID = core.getInput("run_id")
        let runNumber = core.getInput("run_number")
        let checkArtifacts = core.getBooleanInput("check_artifacts")
        let searchArtifacts = core.getBooleanInput("search_artifacts")
        const allowForks = core.getBooleanInput("allow_forks")
        let dryRun = core.getInput("dry_run")

        const client = github.getOctokit(token)

        core.info(`==> Repository: ${owner}/${repo}`)
        core.info(`==> Artifact name: ${name}`)
        core.info(`==> Local path: ${path}`)

        if (!workflow && !workflowSearch) {
            workflow = await getWorkflow(client, owner, repo, runID)
        }

        if (workflow) {
            core.info(`==> Workflow name: ${workflow}`)
        }
        core.info(`==> Workflow conclusion: ${workflowConclusion}`)

        const uniqueInputSets = [
            {
                "pr": pr,
                "commit": commit,
                "branch": branch,
                "ref": ref,
                "run_id": runID
            }
        ]
        uniqueInputSets.forEach((inputSet) => {
            const inputs = Object.values(inputSet)
            const providedInputs = inputs.filter(input => input !== '')
            if (providedInputs.length > 1) {
                throw new Error(`The following inputs cannot be used together: ${Object.keys(inputSet).join(", ")}`)
            }
        })

        if (pr) {
            core.info(`==> PR: ${pr}`)
            const pull = await client.rest.pulls.get({
                owner: owner,
                repo: repo,
                pull_number: pr,
            })
            commit = pull.data.head.sha
            //branch = pull.data.head.ref
        }

        if (ref) {
            // Try to determine if the ref is a branch or a commit
            core.info(`==> Ref: ${ref}`)
            try {
                const response = await client.rest.repos.getBranch({
                    owner: owner,
                    repo: repo,
                    branch: ref,
                })
                branch = ref
            } catch (error) {
                commit = ref
            }
        }

        if (commit) {
            core.info(`==> Commit: ${commit}`)
        }

        if (branch) {
            branch = branch.replace(/^refs\/heads\//, "")
            core.info(`==> Branch: ${branch}`)
        }

        if (event) {
            core.info(`==> Event: ${event}`)
        }

        if (runNumber) {
            core.info(`==> Run number: ${runNumber}`)
        }

        core.info(`==> Allow forks: ${allowForks}`)

        if (!runID) {
            const runGetter = workflow ? client.rest.actions.listWorkflowRuns : client.rest.actions.listWorkflowRunsForRepo
            // Note that the runs are returned in most recent first order.
            for await (const runs of client.paginate.iterator(runGetter, {
                owner: owner,
                repo: repo,
                ...(workflow ? { workflow_id: workflow } : {}),
                ...(branch ? { branch } : {}),
                ...(event ? { event } : {}),
                ...(commit ? { head_sha: commit } : {}),
            }
            )) {
                for (const run of runs.data) {
                    if (runNumber && run.run_number != runNumber) {
                        continue
                    }
                    if (workflowConclusion && (workflowConclusion != run.conclusion && workflowConclusion != run.status)) {
                        continue
                    }
                    if (!allowForks && run.head_repository.full_name !== `${owner}/${repo}`) {
                        core.info(`==> Skipping run from fork: ${run.head_repository.full_name}`)
                        continue
                    }
                    if (checkArtifacts || searchArtifacts) {
                        let artifacts = await client.paginate(client.rest.actions.listWorkflowRunArtifacts, {
                            owner: owner,
                            repo: repo,
                            run_id: run.id,
                        })
                        if (!artifacts || artifacts.length == 0) {
                            continue
                        }
                        if (searchArtifacts) {
                            const artifact = artifacts.find((artifact) => {
                                if (nameIsRegExp) {
                                    return artifact.name.match(name) !== null
                                }
                                return artifact.name == name
                            })
                            if (!artifact) {
                                continue
                            }
                        }
                    }

                    runID = run.id
                    core.info(`==> (found) Run ID: ${runID}`)
                    core.info(`==> (found) Run date: ${run.created_at}`)

                    if (!workflow) {
                        workflow = await getWorkflow(client, owner, repo, runID)
                        core.info(`==> (found) Workflow: ${workflow}`)
                    }
                    break
                }
                if (runID) {
                    break
                }
            }
        }

        if (!runID) {
            if (workflowConclusion && (workflowConclusion != 'in_progress')) {
                return setExitMessage(ifNoArtifactFound, "no matching workflow run found with any artifacts?")
            }

            try {
                return await downloadAction(name, path)
            } catch (error) {
                return setExitMessage(ifNoArtifactFound, "no matching artifact in this workflow?")
            }
        }

        let artifacts = await client.paginate(client.rest.actions.listWorkflowRunArtifacts, {
            owner: owner,
            repo: repo,
            run_id: runID,
        })

        // One artifact if 'name' input is specified, one or more if `name` is a regular expression, all otherwise.
        if (name) {
            const filtered = artifacts.filter((artifact) => {
                if (nameIsRegExp) {
                    return artifact.name.match(name) !== null
                }
                return artifact.name == name
            })
            if (filtered.length == 0) {
                core.info(`==> (not found) Artifact: ${name}`)
                core.info('==> Found the following artifacts instead:')
                for (const artifact of artifacts) {
                    core.info(`\t==> (found) Artifact: ${artifact.name}`)
                }
            }
            artifacts = filtered
        }

        core.setOutput("artifacts", artifacts)

        if (dryRun) {
            if (artifacts.length == 0) {
                core.setOutput("dry_run", false)
                core.setOutput("found_artifact", false)
                return
            } else {
                core.setOutput("dry_run", true)
                core.setOutput("found_artifact", true)
                core.info('==> (found) Artifacts')
                for (const artifact of artifacts) {
                    const size = filesize(artifact.size_in_bytes, { base: 10 })
                    core.info(`\t==> Artifact:`)
                    core.info(`\t==> ID: ${artifact.id}`)
                    core.info(`\t==> Name: ${artifact.name}`)
                    core.info(`\t==> Size: ${size}`)
                }
                return
            }
        }

        if (artifacts.length == 0) {
            return setExitMessage(ifNoArtifactFound, "no artifacts found")
        }

        core.setOutput("found_artifact", true)

        for (const artifact of artifacts) {
            core.info(`==> Artifact: ${artifact.id}`)

            const size = filesize(artifact.size_in_bytes, { base: 10 })

            core.info(`==> Downloading: ${artifact.name}.zip (${size})`)

            // Resolve the pre-signed download URL without buffering the body.
            let downloadUrl
            try {
                downloadUrl = await getArtifactDownloadUrl(client, owner, repo, artifact.id)
            } catch (error) {
                if (error.message.startsWith("Artifact has expired")) {
                    return setExitMessage(ifNoArtifactFound, "no downloadable artifacts found (expired)")
                } else {
                    throw new Error(error.message)
                }
            }

            // For skip_unpack, stream directly to the final destination – no temp file needed.
            if (skipUnpack) {
                fs.mkdirSync(path, { recursive: true })
                const destZipPath = `${pathname.join(path, artifact.name)}.zip`
                await streamUrlToFile(downloadUrl, destZipPath)
                continue
            }

            // Stream the ZIP to a temp file for extraction.
            const tempZipPath = pathname.join(os.tmpdir(), `artifact-${artifact.id}.zip`)
            try {
                await streamUrlToFile(downloadUrl, tempZipPath)

                const dir = name && (!nameIsRegExp || mergeMultiple) ? path : pathname.join(path, artifact.name)

                fs.mkdirSync(dir, { recursive: true })

                core.startGroup(`==> Extracting: ${artifact.name}.zip`)
                if (useUnzip) {
                    // Temp file is already on disk – hand it straight to unzip.
                    await exec.exec("unzip", ["-o", tempZipPath, "-d", dir])
                } else {
                    // AdmZip file-path constructor: reads entries one at a time, not all into RAM.
                    const adm = new AdmZip(tempZipPath)
                    adm.getEntries().forEach((entry) => {
                        const action = entry.isDirectory ? "creating" : "inflating"
                        const filepath = pathname.join(dir, entry.entryName)

                        core.info(`  ${action}: ${filepath}`)
                    })
                    adm.extractAllTo(dir, true)
                }
                core.endGroup()
            } finally {
                // Always clean up the temp file, even if extraction failed.
                try { fs.rmSync(tempZipPath) } catch (e) { core.debug(`Failed to remove temp file ${tempZipPath}: ${e.message}`) }
            }
        }
    } catch (error) {
        core.setOutput("found_artifact", false)
        core.setOutput("error_message", error.message)
        core.setFailed(error.message)
    }

    function setExitMessage(ifNoArtifactFound, message) {
        core.setOutput("found_artifact", false)

        switch (ifNoArtifactFound) {
            case "fail":
                core.setFailed(message)
                break
            case "warn":
                core.warning(message)
                break
            case "ignore":
            default:
                core.info(message)
                break
        }
    }
}

main()
