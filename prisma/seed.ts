import { PrismaClient, CourseType, DietaryType, KitchenStation } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Re-runnable: wipe the demo restaurant (cascades to tables, categories, items, orders)
  await prisma.restaurant.deleteMany({ where: { slug: 'demo-bistro' } });

  const restaurant = await prisma.restaurant.create({
    data: {
      name: 'Demo Bistro',
      slug: 'demo-bistro',
      currency: 'INR',
      taxRate: 5.0,
      serviceCharge: 5.0,
    },
  });

  // Staff accounts for the KDS / waiter screens. DEV ONLY: shared demo password.
  const passwordHash = await bcrypt.hash('Password123!', 10);
  for (const [name, email, role] of [
    ['Asha (Admin)', 'admin@demobistro.test', 'ADMIN'],
    ['Ravi (Chef)', 'chef@demobistro.test', 'CHEF'],
    ['Meera (Captain)', 'captain@demobistro.test', 'CAPTAIN'],
    ['Joel (Waiter)', 'waiter@demobistro.test', 'WAITER'],
  ] as const) {
    await prisma.staffUser.upsert({
      where: { email },
      update: { restaurantId: restaurant.id, passwordHash, role, name },
      create: { restaurantId: restaurant.id, name, email, passwordHash, role },
    });
  }

  // Tables: each gets a token (this is what the QR code encodes).
  // DEV ONLY: predictable tokens like 'demo-table-1' keep manual testing easy.
  // Real deployments must generate long random (or signed) tokens per table.
  const tableNames = ['Table 1', 'Table 2', 'Table 3', 'Table 4', 'Patio 1', 'Bar Seat 1'];
  for (const tableNumber of tableNames) {
    await prisma.restaurantTable.create({
      data: {
        restaurantId: restaurant.id,
        tableNumber,
        qrScannerToken: `demo-${tableNumber.toLowerCase().replace(/\s+/g, '-')}`,
        tableCapacity: tableNumber.startsWith('Bar') ? 1 : 4,
      },
    });
  }

  const spiceModifier = [
    {
      name: 'Spice Level',
      required: true,
      options: [
        { name: 'Mild', cost: 0 },
        { name: 'Medium', cost: 0 },
        { name: 'Hot', cost: 0 },
      ],
    },
  ];

  const menu: {
    category: string;
    order: number;
    items: {
      name: string;
      description: string;
      price: number;
      dietaryType: DietaryType;
      courseType: CourseType;
      station: KitchenStation;
      allergens?: string[];
      modifierGroups?: unknown;
    }[];
  }[] = [
    {
      category: 'Starters',
      order: 1,
      items: [
        { name: 'Paneer Tikka', description: 'Char-grilled cottage cheese with mint chutney', price: 280, dietaryType: 'VEG', courseType: 'APPETIZER', station: 'HOT', allergens: ['DAIRY'], modifierGroups: spiceModifier },
        { name: 'Greek Salad', description: 'Cucumber, olives, feta, oregano', price: 220, dietaryType: 'VEG', courseType: 'APPETIZER', station: 'COLD', allergens: ['DAIRY'] },
      ],
    },
    {
      category: 'Main Course',
      order: 2,
      items: [
        { name: 'Butter Chicken', description: 'Creamy tomato gravy, tandoori chicken', price: 420, dietaryType: 'NON_VEG', courseType: 'ENTREE', station: 'HOT', allergens: ['DAIRY', 'NUTS'], modifierGroups: spiceModifier },
        { name: 'Vegetable Biryani', description: 'Basmati rice, seasonal vegetables, raita', price: 320, dietaryType: 'VEG', courseType: 'ENTREE', station: 'HOT', modifierGroups: spiceModifier },
      ],
    },
    {
      category: 'Desserts',
      order: 3,
      items: [
        { name: 'Gulab Jamun', description: 'Warm milk dumplings in rose syrup', price: 150, dietaryType: 'VEG', courseType: 'DESSERT', station: 'COLD', allergens: ['DAIRY', 'GLUTEN'] },
      ],
    },
    {
      category: 'Beverages',
      order: 4,
      items: [
        { name: 'Fresh Lime Soda', description: 'Sweet or salted', price: 90, dietaryType: 'VEGAN', courseType: 'BEVERAGE', station: 'BAR' },
        { name: 'Masala Chai', description: 'Ginger and cardamom tea', price: 60, dietaryType: 'VEG', courseType: 'BEVERAGE', station: 'BAR', allergens: ['DAIRY'] },
      ],
    },
  ];

  for (const group of menu) {
    const category = await prisma.menuCategory.create({
      data: { restaurantId: restaurant.id, name: group.category, displayOrder: group.order },
    });
    for (const item of group.items) {
      await prisma.menuItem.create({
        data: {
          categoryId: category.id,
          name: item.name,
          description: item.description,
          price: item.price,
          dietaryType: item.dietaryType,
          courseType: item.courseType,
          station: item.station,
          allergens: item.allergens ?? [],
          modifierGroups: (item.modifierGroups as object) ?? [],
        },
      });
    }
  }

  const tables = await prisma.restaurantTable.findMany({
    where: { restaurantId: restaurant.id },
    orderBy: { tableNumber: 'asc' },
  });
  console.log('Seeded Demo Bistro. Staff login (all roles): <role>@demobistro.test / Password123!');
  console.log('Scan URLs for testing:');
  for (const t of tables) {
    console.log(`  ${t.tableNumber}: http://localhost:3000/scan/${t.qrScannerToken}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
