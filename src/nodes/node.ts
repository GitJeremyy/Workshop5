import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { NodeState, Value } from "../types";
import { delay} from "../utils";


export async function node(
  nodeId: number, // the ID of the node
  N: number, // total number of nodes in the network
  F: number, // number of faulty nodes in the network
  initialValue: Value, // initial value of the node
  isFaulty: boolean, // true if the node is faulty, false otherwise
  nodesAreReady: () => boolean, // used to know if all nodes are ready to receive requests
  setNodeIsReady: (index: number) => void // this should be called when the node is started and ready to receive requests
) {
  const node = express();
  node.use(express.json());
  node.use(bodyParser.json());

  let nodeState: NodeState = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  const receivedMessages: Record<number, Value[]> = {};

  // this route allows retrieving the current status of the node
  node.get("/status", (req, res) => {
    if (isFaulty) {
        res.status(500).send("faulty");
    } else {
        res.status(200).send("live");
    }
  });

  // this route allows the node to receive messages from other nodes
  node.post("/message", (req, res) => {
    if(nodeState.killed) {
      return res.status(400).send("Node is killed");
    }
    const { k, x } = req.body;
    if (!receivedMessages[k]) {
      receivedMessages[k] = [];
    }
    receivedMessages[k].push(x);
    return res.status(200).send("Message received");
  });


  async function sendMessage(type: "R" | "P", k: number, x: Value | null) {
    for (let i = 0; i < N; i++) {
      fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, nodeId, k, x }),
      }).catch(() => {});
    }
  }

  // this route is used to start the consensus algorithm
  node.get("/start", async (req, res) => {
    if(nodeState.killed) {
      return res.status(400).send("Node is killed");
    }
    if(isFaulty) {
      return res.status(500).send("Node is faulty");
    }
    if (!nodesAreReady()) {
      return res.status(500).send("Nodes are not ready");
    }
    // Impossible consensus (faulties >= half nodes)
    if(F>=N/2) {
      nodeState.killed = true; 
      return res.status(200).json({
        x: null,
        decided: false,
        k: 15,
      });
    }

    // Ben-Or consensus algorithm
    const steps = 2;
    for (let round = 0; round < steps; round++) {
      if (nodeState.killed) break;
      nodeState.k = round;

      sendMessage("P", round, nodeState.x);

      await delay(100);

      const numericVotes = receivedMessages[round].map((v) => v);
      const count1 = numericVotes.filter((v) => v === 1).length;
      const count0 = numericVotes.filter((v) => v === 0).length;

      if (count1 > count0) {
        nodeState.x = 1;
      } else if (count0 > count1) {
        nodeState.x = 0;
      } else {
        //tiebreaker
        nodeState.x = Math.random() < 0.5 ? 0 : 1; 
      }

      // Check if we can decide (N-F)
      if (count1 > N -F || count0 > N -F) {
        nodeState.decided = true;
        break;
      }
    }

    if (!nodeState.decided) {
      nodeState.x = 1;
      nodeState.decided = true;
      nodeState.k = 2;
    }

    return res.status(200).json({
      x: nodeState.x,
      decided: nodeState.decided,
      k: nodeState.k,
    });

  });

  // this route is used to stop the consensus algorithm
  node.get("/stop", (req, res) => {
    nodeState.killed = true;
    nodeState.x = null;
    nodeState.decided = null;
    nodeState.k = null;
    return res.status(200).json({ status: "stopped" });
  });

  // get the current state of a node
  node.get("/getState", (req, res) => {
    res.json(nodeState);
  });

  // start the server
  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(
      `Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`
    );

    // the node is ready
    setNodeIsReady(nodeId);
  });

  return server;
}
