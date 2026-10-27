import { AgentOs } from "@rivet-dev/agentos-core";

const vm1 = await AgentOs.create();
const vm2 = await AgentOs.create();

try {
  console.log("started");
  await vm1.filesystem.writeFile("/tmp/hello.txt", "hello\n");

  const result = await vm.process.exec(
    "cat /tmp/hello.txt", 
    {output: { capture : "all"}}
  );
  console.log(result.stdout);
} finally {
  await vm.dispose();
}
