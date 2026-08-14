export interface SampleSession {
	id: string;
	title: string;
	description: string;
	badge: string;
	data: unknown;
}

export const SAMPLE_SESSIONS: SampleSession[] = [
	{
		id: 'sample-shipment-form',
		title: 'Shipment Form Layout Bug',
		description: 'Multi-turn autonomous coding session resolving overlap and placement in shipment UI.',
		badge: 'Multi-turn Debug',
		data: {
			exportVersion: 1,
			session: {
				id: 'sample-shipment-form-debug',
				displayTitle: {
					value: 'FIX: Shipment Form AWB Placeholder Overlap',
					source: 'user_prompt'
				},
				startedAt: '2026-08-14T09:12:00.000Z',
				recordCount: 4,
				token: {
					total: { totalTokens: 42800, inputTokens: 38200, outputTokens: 4600 },
					last: { totalTokens: 42800, inputTokens: 38200, outputTokens: 4600 },
					observations: 3,
					missingUsageObservations: 0
				},
				tools: { calls: 8, outputs: 8, execCompleted: 4, mcpCompleted: 4 },
				conversation: [
					{
						id: 'msg-user-1',
						role: 'user',
						kind: 'conversation',
						timestamp: '2026-08-14T09:12:00.000Z',
						text: 'In the AWB field in the shipment form, the loader and check icon place is overlapping the placeholder text. Fix it!'
					},
					{
						id: 'msg-agent-1',
						role: 'assistant',
						kind: 'conversation',
						timestamp: '2026-08-14T09:12:45.000Z',
						text: "I analyzed `shipment-form.svelte` and adjusted the padding-right offset on the input element when status icons are rendered. This ensures the placeholder and icons never collide.",
						activity: {
							tools: [
								{ type: 'view_file', path: 'src/components/shared/shipment/shipment-form.svelte' },
								{ type: 'replace_file_content', path: 'src/components/shared/shipment/shipment-form.svelte' }
							],
							modelRequests: [
								{ usage: { totalTokens: 21400, inputTokens: 19100, outputTokens: 2300 } },
								{ usage: { totalTokens: 21400, inputTokens: 19100, outputTokens: 2300 } }
							]
						}
					}
				]
			}
		}
	},
	{
		id: 'sample-token-spike',
		title: 'High-Token Reasoning Trace',
		description: 'Single message snippet export highlighting heavy token consumption step.',
		badge: 'Single Snippet',
		data: {
			exportVersion: 1,
			sessionTitle: 'Complex Cypher Query Optimization Trace',
			message: {
				id: 'msg-snippet-cypher',
				role: 'assistant',
				kind: 'conversation',
				timestamp: '2026-08-14T10:00:00.000Z',
				text: 'Executed deep path traversal across 14,000 nodes in graph database to map dependency graph.',
				activity: {
					tools: [
						{ type: 'query_graph', cypher: 'MATCH (n:Function)-[r:CALLS*1..5]->(m:Function) RETURN n, r, m' }
					],
					modelRequests: [
						{ usage: { totalTokens: 89500, inputTokens: 84000, outputTokens: 5500 } }
					]
				}
			}
		}
	}
];
