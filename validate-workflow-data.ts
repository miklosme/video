import { loadWorkflowData, validateWorkflowConsistency } from './workflow-data';

async function main() {
  const data = await loadWorkflowData();
  validateWorkflowConsistency(data);
  const shotCount = data.storyboard.scenes.reduce((total, scene) => total + scene.shots.length, 0);

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        currentPhase: data.project.currentPhase,
        storyboardScenes: data.storyboard.scenes.length,
        storyboardShots: shotCount,
        keyframeShots: data.keyframes.shots.length,
        referenceAssets: data.references.assets.length,
        generationLogEntries: data.generationLog.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
