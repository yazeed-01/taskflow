import { prisma } from '../src/db.js';
import { ensureBenchData } from './benchData.js';

await ensureBenchData();
await prisma.$disconnect();
