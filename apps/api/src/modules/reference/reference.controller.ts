import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { asc, eq } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import { Public } from '../../common/auth/auth.guard.js';
import { DATABASE } from '../../common/database.module.js';

export interface ReferenceDataDto {
  cities: {
    id: string;
    slug: string;
    name: string;
    districts: { id: string; slug: string; name: string; latitude: number; longitude: number }[];
  }[];
  categories: { id: string; slug: string; name: string; icon: string }[];
}

/**
 * Référentiels publics : villes, communes, catégories.
 *
 * Une seule réponse, fortement cacheable — ces données changent quand TRY ouvre
 * une ville, pas entre deux requêtes. L'assistant d'onboarding business en a
 * besoin avant toute création, et l'app mobile pour le fallback « choisis ta
 * commune » quand la localisation est refusée.
 *
 * Les centroïdes de commune sont exposés exprès : demander une latitude à un
 * gérant de salle est une impasse UX, on positionne d'abord sur la commune et la
 * position fine s'ajuste ensuite (géocodage à venir, voir PROJECT_PLAN).
 */
@ApiTags('reference')
@Controller({ path: 'reference', version: '1' })
export class ReferenceController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Villes, communes et catégories actives' })
  async reference(): Promise<ReferenceDataDto> {
    const [cities, districts, categories] = await Promise.all([
      this.db
        .select({ id: schema.cities.id, slug: schema.cities.slug, name: schema.cities.name })
        .from(schema.cities)
        .where(eq(schema.cities.isActive, true))
        .orderBy(asc(schema.cities.name)),
      this.db
        .select({
          id: schema.districts.id,
          cityId: schema.districts.cityId,
          slug: schema.districts.slug,
          name: schema.districts.name,
          latitude: schema.districts.latitude,
          longitude: schema.districts.longitude,
        })
        .from(schema.districts)
        .orderBy(asc(schema.districts.name)),
      this.db
        .select({
          id: schema.categories.id,
          slug: schema.categories.slug,
          name: schema.categories.name,
          icon: schema.categories.icon,
        })
        .from(schema.categories)
        .where(eq(schema.categories.isActive, true))
        .orderBy(asc(schema.categories.sortOrder)),
    ]);

    return {
      cities: cities.map((city) => ({
        ...city,
        districts: districts.filter((district) => district.cityId === city.id),
      })),
      categories,
    };
  }
}
